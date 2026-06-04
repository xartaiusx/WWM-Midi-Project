import argparse
import time
import wave


def main():
    parser = argparse.ArgumentParser(description="Record Windows system audio via WASAPI loopback.")
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    if args.seconds <= 0 or args.seconds > 600:
        raise SystemExit("Recording duration must be between 1 and 600 seconds.")

    try:
        import pyaudiowpatch as pyaudio
    except ImportError as exc:
        raise SystemExit(
            "PyAudioWPatch is not installed. Run scripts\\setup-audio-midi.cmd first."
        ) from exc

    chunk_size = 1024

    with pyaudio.PyAudio() as audio:
        device = audio.get_default_wasapi_loopback()
        rate = int(device.get("defaultSampleRate", 44100))
        channels = int(device.get("maxInputChannels") or device.get("maxOutputChannels") or 2)
        channels = max(1, channels)
        sample_format = pyaudio.paInt16
        sample_width = audio.get_sample_size(sample_format)

        frames = []

        def callback(in_data, frame_count, time_info, status):
            if in_data:
                frames.append(in_data)
            return (None, pyaudio.paContinue)

        stream = audio.open(
            format=sample_format,
            channels=channels,
            rate=rate,
            frames_per_buffer=chunk_size,
            input=True,
            input_device_index=device["index"],
            stream_callback=callback,
        )

        try:
            stream.start_stream()
            time.sleep(args.seconds)
        finally:
            stream.stop_stream()
            stream.close()

    if not frames:
        silent_frame_count = int(rate * args.seconds)
        frames.append(b"\x00" * silent_frame_count * channels * sample_width)

    with wave.open(args.output, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(rate)
        wav_file.writeframes(b"".join(frames))

    print(f"Recorded {args.seconds:.1f}s loopback audio to {args.output}")


if __name__ == "__main__":
    main()
