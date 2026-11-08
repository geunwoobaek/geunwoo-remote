/**
 * The computer's screen, live on the phone.
 *
 * - `startScreenStream` answers the phone's WebRTC offer (receive-only
 *   video) and starts ffmpeg capturing the screen into VP8 RTP on a
 *   localhost UDP port, which werift sends to the phone. The offer and
 *   answer travel as session RPCs, so they go through the encrypted relay
 *   like everything else; the video itself goes phone-to-computer, DTLS-SRTP
 *   encrypted. The STUN server only learns the two addresses.
 * - A stream ends, and ffmpeg is killed, on `stopScreenStream`, when the
 *   connection fails or closes (or stays disconnected for 10 s), after
 *   `MAX_STREAM_MS`, when ffmpeg exits, and when this process exits. Only
 *   one stream runs at a time: a new one ends the last.
 * - `screenFrame` is the fallback when no direct connection can be made
 *   (a phone on mobile data behind a strict NAT, with no TURN relay): one
 *   downscaled JPEG of the screen, returned through the relay itself.
 *
 * Nothing is captured until the phone asks. macOS only; the first capture
 * needs Screen Recording permission for the process that runs happy.
 */
import { ChildProcess, execFile, spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpPacket } from 'werift';
import { logger } from '@/ui/logger';

const execFileAsync = promisify(execFile);

export const MAX_STREAM_MS = 10 * 60 * 1000;
const DISCONNECT_GRACE_MS = 10_000;
const GATHER_TIMEOUT_MS = 5_000;
const VP8_PAYLOAD_TYPE = 96;
export const STUN_SERVER = 'stun:stun.l.google.com:19302';

export interface ScreenStreamOptions {
    /** Widest the picture is sent, in pixels. */
    maxWidth?: number;
    fps?: number;
}

export interface ScreenStreamStart {
    success: boolean;
    id?: string;
    sdp?: string;
    error?: string;
}

export interface ScreenFrame {
    success: boolean;
    /** Base64 JPEG. */
    content?: string;
    error?: string;
}

/** Where ffmpeg is, or null. */
export function findFfmpeg(): string | null {
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
        if (existsSync(candidate)) return candidate;
    }
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir && existsSync(join(dir, 'ffmpeg'))) return join(dir, 'ffmpeg');
    }
    return null;
}

/** avfoundation's first screen in ffmpeg's device listing (`[3] Capture screen 0`), or null. */
export function screenDeviceIn(listing: string): number | null {
    const match = /\[(\d+)\]\s+Capture screen 0/.exec(listing);
    return match ? Number(match[1]) : null;
}

async function screenDevice(ffmpeg: string): Promise<number | null> {
    // ffmpeg lists the devices on stderr and exits non-zero (no input given).
    const listing = await execFileAsync(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
        .then((r) => `${r.stdout}\n${r.stderr}`)
        .catch((e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}\n${e.stderr ?? ''}`);
    return screenDeviceIn(listing);
}

/** ffmpeg's arguments: [source] (the screen, or a test pattern) to VP8 RTP at [port], short GOP so a lost frame recovers in ~2 s. */
export function encoderArguments(source: string[], port: number, maxWidth: number, fps: number): string[] {
    return [
        '-hide_banner', '-loglevel', 'error',
        ...source,
        '-vf', `scale='min(${maxWidth},iw)':-2`,
        '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1500k',
        '-g', String(fps * 2), '-lag-in-frames', '0', '-error-resilient', '1', '-auto-alt-ref', '0',
        '-an', '-payload_type', String(VP8_PAYLOAD_TYPE),
        '-f', 'rtp', `rtp://127.0.0.1:${port}?pkt_size=1200`,
    ];
}

function screenSource(device: number, fps: number): string[] {
    return ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', String(fps), '-i', `${device}:none`];
}

interface ActiveStream {
    id: string;
    stop: (reason: string) => void;
}

let active: ActiveStream | null = null;
let exitHooked = false;

function hookProcessExit(): void {
    if (exitHooked) return;
    exitHooked = true;
    const end = () => active?.stop('process exit');
    process.once('exit', end);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
            end();
            // Re-raise so the process still ends the way it was asked to.
            process.kill(process.pid, signal);
        });
    }
}

function gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
        pc.iceGatheringStateChange.subscribe((state) => {
            if (state === 'complete') {
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

/** Whether a stream is running, and its id. */
export function activeScreenStream(): string | null {
    return active?.id ?? null;
}

/**
 * Answers [offerSdp] and starts sending the screen. [source] replaces the
 * screen for tests (an ffmpeg input such as a lavfi test pattern).
 */
export async function startScreenStream(
    offerSdp: string,
    options: ScreenStreamOptions = {},
    source?: string[],
): Promise<ScreenStreamStart> {
    if (!source && process.platform !== 'darwin') return { success: false, error: 'Live screen is only available on macOS' };
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return { success: false, error: 'ffmpeg is not installed on the computer (brew install ffmpeg)' };
    const fps = Math.min(Math.max(Math.round(options.fps ?? 15), 1), 30);
    const maxWidth = Math.min(Math.max(Math.round(options.maxWidth ?? 1280), 320), 1920);
    let input = source;
    if (!input) {
        const device = await screenDevice(ffmpeg);
        if (device === null) return { success: false, error: 'No screen found to capture' };
        input = screenSource(device, fps);
    }

    active?.stop('replaced');
    hookProcessExit();

    const vp8 = () => new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90000, payloadType: VP8_PAYLOAD_TYPE });
    const pc = new RTCPeerConnection({ codecs: { video: [vp8()] }, iceServers: [{ urls: STUN_SERVER }] });
    const track = new MediaStreamTrack({ kind: 'video' });
    let udp: Socket | null = null;
    let encoder: ChildProcess | null = null;
    const timers: NodeJS.Timeout[] = [];
    const id = `screen-${Date.now().toString(36)}`;
    let stopped = false;

    const stop = (reason: string) => {
        if (stopped) return;
        stopped = true;
        logger.debug(`[screenStream] ${id} stopped: ${reason}`);
        timers.forEach(clearTimeout);
        if (encoder && encoder.exitCode === null) encoder.kill('SIGKILL');
        try { udp?.close(); } catch { /* already closed */ }
        track.stop();
        void pc.close().catch(() => undefined);
        if (active?.id === id) active = null;
    };
    active = { id, stop };

    try {
        pc.addTransceiver(track, { direction: 'sendonly' });
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);

        let disconnectTimer: NodeJS.Timeout | null = null;
        pc.connectionStateChange.subscribe((state) => {
            if (state === 'failed' || state === 'closed') stop(`connection ${state}`);
            if (state === 'disconnected' && !disconnectTimer) {
                disconnectTimer = setTimeout(() => stop('disconnected'), DISCONNECT_GRACE_MS);
                timers.push(disconnectTimer);
            }
            if (state === 'connected' && disconnectTimer) {
                clearTimeout(disconnectTimer);
                disconnectTimer = null;
            }
        });
        timers.push(setTimeout(() => stop('time limit'), MAX_STREAM_MS));

        const socket = createSocket('udp4');
        udp = socket;
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(0, '127.0.0.1', () => resolve());
        });
        const payloadType = pc.getTransceivers()[0]?.codecs?.[0]?.payloadType ?? VP8_PAYLOAD_TYPE;
        socket.on('message', (buffer) => {
            const rtp = RtpPacket.deSerialize(buffer);
            rtp.header.payloadType = payloadType;
            track.writeRtp(rtp);
        });

        const child = spawn(ffmpeg, encoderArguments(input, socket.address().port, maxWidth, fps), { stdio: ['ignore', 'ignore', 'pipe'] });
        encoder = child;
        let errors = '';
        child.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
        child.on('exit', (code) => stop(`ffmpeg exited ${code}${errors ? `: ${errors.trim()}` : ''}`));

        const answer = pc.localDescription?.sdp;
        if (!answer) throw new Error('No answer');
        return { success: true, id, sdp: answer };
    } catch (error) {
        stop('failed to start');
        return { success: false, error: error instanceof Error ? error.message : 'Failed to start the live screen' };
    }
}

/** Ends the stream [id] (or whichever runs, without one). */
export function stopScreenStream(id?: string): { success: boolean } {
    if (active && (!id || active.id === id)) active.stop('asked');
    return { success: true };
}

/** One JPEG of the screen, at most [maxWidth] wide, for when no direct connection can be made. */
export async function screenFrame(maxWidth = 960): Promise<ScreenFrame> {
    if (process.platform !== 'darwin') return { success: false, error: 'Screen capture is only available on macOS' };
    const width = Math.min(Math.max(Math.round(maxWidth), 320), 1920);
    const dir = await mkdtemp(join(tmpdir(), 'happy-frame-'));
    const file = join(dir, 'frame.jpg');
    try {
        await execFileAsync('screencapture', ['-x', '-t', 'jpg', file], { timeout: 15_000 });
        await execFileAsync('sips', ['-Z', String(width), '-s', 'formatOptions', '60', file], { timeout: 15_000 });
        const bytes = await readFile(file);
        return { success: true, content: bytes.toString('base64') };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to capture the screen' };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
