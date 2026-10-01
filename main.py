"""
Gemini Live API Interactive Client
Audio, Video (Camera/Screen), and Text streaming.
"""

import os
import asyncio
import base64
import io
import traceback
import argparse
from dotenv import load_dotenv

import cv2
import pyaudio
import PIL.Image

from google import genai
from google.genai import types

# Load environment variables from .env file if present
load_dotenv()

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024

DEFAULT_MODEL = os.environ.get("GEMINI_LIVE_MODEL", "models/gemini-3.1-flash-live-preview")
DEFAULT_VOICE = os.environ.get("GEMINI_VOICE", "Achird")
DEFAULT_MODE = "camera"

def get_client():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("\n" + "=" * 60)
        print(" [ERROR] GEMINI_API_KEY is not set!")
        print(" Please add your Gemini API key to a .env file:")
        print("   GEMINI_API_KEY=your_api_key_here")
        print(" Or export it in PowerShell:")
        print('   $env:GEMINI_API_KEY="your_api_key_here"')
        print(" Get a free API key at: https://aistudio.google.com/apikey")
        print("=" * 60 + "\n")
        return None
    return genai.Client(
        http_options={"api_version": "v1beta"},
        api_key=api_key,
    )

def create_connect_config(voice_name=DEFAULT_VOICE):
    return types.LiveConnectConfig(
        response_modalities=[
            "AUDIO",
        ],
        media_resolution="MEDIA_RESOLUTION_MEDIUM",
        thinking_config=types.ThinkingConfig(
            thinking_level="MINIMAL",
        ),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=104857,
            sliding_window=types.SlidingWindow(target_tokens=52428),
        ),
    )

pya = pyaudio.PyAudio()


class AudioLoop:
    def __init__(self, client, model=DEFAULT_MODEL, video_mode=DEFAULT_MODE, voice=DEFAULT_VOICE):
        self.client = client
        self.model = model
        self.video_mode = video_mode
        self.voice = voice

        self.audio_in_queue = None
        self.out_queue = None

        self.session = None

        self.send_text_task = None
        self.receive_audio_task = None
        self.play_audio_task = None

        self.audio_stream = None

    async def send_text(self):
        while True:
            text = await asyncio.to_thread(
                input,
                "message > ",
            )
            if text.lower() == "q":
                break
            if self.session is not None:
                await self.session.send_client_content(
                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=text or ".")])],
                    turn_complete=True
                )

    def _get_frame(self, cap):
        ret, frame = cap.read()
        if not ret:
            return None
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = PIL.Image.fromarray(frame_rgb)
        img.thumbnail([1024, 1024])

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        mime_type = "image/jpeg"
        image_bytes = image_io.read()
        return {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}

    async def get_frames(self):
        cap = await asyncio.to_thread(cv2.VideoCapture, 0)

        while True:
            frame = await asyncio.to_thread(self._get_frame, cap)
            if frame is None:
                break

            await asyncio.sleep(1.0)

            if self.out_queue is not None:
                await self.out_queue.put(frame)

        cap.release()

    def _get_screen(self):
        try:
            import mss
        except ImportError as e:
            raise ImportError("Please install mss package using 'pip install mss'") from e
        sct = mss.mss()
        monitor = sct.monitors[0]

        i = sct.grab(monitor)

        mime_type = "image/jpeg"
        image_bytes = mss.tools.to_png(i.rgb, i.size)
        img = PIL.Image.open(io.BytesIO(image_bytes))

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        image_bytes = image_io.read()
        return {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}

    async def get_screen(self):
        while True:
            frame = await asyncio.to_thread(self._get_screen)
            if frame is None:
                break

            await asyncio.sleep(1.0)

            if self.out_queue is not None:
                await self.out_queue.put(frame)

    async def send_realtime(self):
        while True:
            if self.out_queue is not None:
                msg = await self.out_queue.get()
                if self.session is not None:
                    if msg.get("mime_type") == "audio/pcm":
                        await self.session.send_realtime_input(audio=msg)
                    else:
                        await self.session.send_realtime_input(video=msg)

    async def listen_audio(self):
        mic_info = pya.get_default_input_device_info()
        self.audio_stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=SEND_SAMPLE_RATE,
            input=True,
            input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        kwargs = {"exception_on_overflow": False} if __debug__ else {}
        while True:
            data = await asyncio.to_thread(self.audio_stream.read, CHUNK_SIZE, **kwargs)
            if self.out_queue is not None:
                await self.out_queue.put({"data": data, "mime_type": "audio/pcm"})

    async def receive_audio(self):
        """Background task to read from websocket and write pcm chunks to output queue"""
        while True:
            if self.session is not None:
                turn = self.session.receive()
                async for response in turn:
                    if data := response.data:
                        self.audio_in_queue.put_nowait(data)
                        continue
                    if text := response.text:
                        print(text, end="", flush=True)

                    if hasattr(response, "server_content") and response.server_content:
                        sc = response.server_content
                        if getattr(sc, "output_transcription", None) and sc.output_transcription.text:
                            print(sc.output_transcription.text, end="", flush=True)
                        elif getattr(sc, "model_turn", None) and sc.model_turn.parts:
                            for part in sc.model_turn.parts:
                                if getattr(part, "text", None):
                                    print(part.text, end="", flush=True)

                while not self.audio_in_queue.empty():
                    self.audio_in_queue.get_nowait()

    async def play_audio(self):
        stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=RECEIVE_SAMPLE_RATE,
            output=True,
        )
        while True:
            if self.audio_in_queue is not None:
                bytestream = await self.audio_in_queue.get()
                await asyncio.to_thread(stream.write, bytestream)

    async def run(self):
        try:
            config = create_connect_config(voice_name=self.voice)
            async with (
                self.client.aio.live.connect(model=self.model, config=config) as session,
                asyncio.TaskGroup() as tg,
            ):
                self.session = session

                self.audio_in_queue = asyncio.Queue()
                self.out_queue = asyncio.Queue(maxsize=5)

                send_text_task = tg.create_task(self.send_text())
                tg.create_task(self.send_realtime())
                tg.create_task(self.listen_audio())
                if self.video_mode == "camera":
                    tg.create_task(self.get_frames())
                elif self.video_mode == "screen":
                    tg.create_task(self.get_screen())

                tg.create_task(self.receive_audio())
                tg.create_task(self.play_audio())

                await send_text_task
                raise asyncio.CancelledError("User requested exit")

        except asyncio.CancelledError:
            pass
        except ExceptionGroup as EG:
            if self.audio_stream is not None:
                self.audio_stream.close()
                traceback.print_exception(EG)


if __name__ == "__main__":
    import sys

    parser = argparse.ArgumentParser(description="Gemini Flash Live Interactive Assistant")
    parser.add_argument(
        "--mode",
        type=str,
        default=DEFAULT_MODE,
        help="Pixels to stream: 'camera', 'screen', or 'none'",
        choices=["camera", "screen", "none"],
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Gemini Live model to use (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--voice",
        type=str,
        default=DEFAULT_VOICE,
        help=f"Voice name (e.g. Achird, Gacrux, Zephyr, Puck) (default: {DEFAULT_VOICE})",
    )
    args = parser.parse_args()

    client = get_client()
    if client is None:
        sys.exit(1)

    print("\n" + "=" * 60)
    print(" [*] Connecting to Gemini Live API...")
    print(f" [*] Model : {args.model}")
    print(f" [*] Voice : {args.voice}")
    print(f" [*] Mode  : {args.mode}")
    print(" [*] Speak into your mic to chat, or type below.")
    print(" [*] Type 'q' and press Enter to exit.")
    print("=" * 60 + "\n")

    main = AudioLoop(client=client, model=args.model, video_mode=args.mode, voice=args.voice)
    asyncio.run(main.run())
