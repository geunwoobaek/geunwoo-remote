/**
 * The live screen end to end on this machine, without the screen: a
 * test pattern stands in for it, and a receive-only werift peer for the
 * phone. Its offer is answered, the pattern arrives as VP8 with keyframes,
 * and a stop ends the stream and its ffmpeg.
 */
import { describe, expect, it } from 'vitest';
import { RTCPeerConnection, RTCRtpCodecParameters, RtpPacket } from 'werift';
import { activeScreenStream, encoderArguments, findFfmpeg, screenDeviceIn, startScreenStream, stopScreenStream } from './screenStream';

function gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => pc.iceGatheringStateChange.subscribe((state) => { if (state === 'complete') resolve(); }));
}

/** A VP8 packet that starts a keyframe (RFC 7741 payload descriptor, then the P bit of the frame header). */
function startsKeyframe(rtp: RtpPacket): boolean {
    const p = rtp.payload;
    let i = 1;
    if (p[0] & 0x80) {
        i++;
        if (p[1] & 0x80) i += (p[2] & 0x80) ? 2 : 1;
        if (p[1] & 0x40) i++;
        if (p[1] & 0x30) i++;
    }
    return (p[0] & 0x10) !== 0 && (p[i] & 0x01) === 0;
}

describe('screenStream', () => {
    it('finds the first screen in ffmpeg\'s device listing', () => {
        const listing = [
            '[AVFoundation indev @ 0x1] AVFoundation video devices:',
            '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
            '[AVFoundation indev @ 0x1] [2] Capture screen 0',
            '[AVFoundation indev @ 0x1] [3] Capture screen 1',
        ].join('\n');
        expect(screenDeviceIn(listing)).toBe(2);
        expect(screenDeviceIn('[0] FaceTime HD Camera')).toBeNull();
    });

    it('encodes to VP8 RTP on localhost with a two second GOP', () => {
        const args = encoderArguments(['-i', 'x'], 5004, 1280, 15);
        expect(args).toContain('libvpx');
        expect(args[args.indexOf('-g') + 1]).toBe('30');
        expect(args.at(-1)).toBe('rtp://127.0.0.1:5004?pkt_size=1200');
    });

    it.skipIf(!findFfmpeg())('sends a test pattern to a receive-only peer until stopped', async () => {
        const viewer = new RTCPeerConnection({ codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96 })] } });
        viewer.addTransceiver('video', { direction: 'recvonly' });
        let packets = 0;
        let keyframes = 0;
        viewer.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => {
            packets++;
            if (startsKeyframe(rtp)) keyframes++;
        }));
        await viewer.setLocalDescription(await viewer.createOffer());
        await gathered(viewer);

        const started = await startScreenStream(viewer.localDescription!.sdp, { maxWidth: 640, fps: 15 }, ['-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15']);
        expect(started.success).toBe(true);
        expect(activeScreenStream()).toBe(started.id);
        await viewer.setRemoteDescription({ type: 'answer', sdp: started.sdp! });

        await new Promise((resolve) => setTimeout(resolve, 5000));
        expect(packets).toBeGreaterThan(50);
        expect(keyframes).toBeGreaterThanOrEqual(2);

        stopScreenStream(started.id);
        expect(activeScreenStream()).toBeNull();
        const after = packets;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(packets - after).toBeLessThan(5);
        await viewer.close();
    }, 30_000);
});
