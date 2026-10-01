"""
Gemini Flash Live - FastAPI Web Backend
Provides WebSocket bridge between Web Audio/Video frontend and Google Gemini Live API.
"""

import os
import sys
import json
import base64
import asyncio
import traceback
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

from google import genai
from google.genai import types

load_dotenv()

app = FastAPI(title="Gemini Flash Live Playground")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(STATIC_DIR, exist_ok=True)

DEFAULT_MODEL = os.environ.get("GEMINI_LIVE_MODEL", "models/gemini-3.1-flash-live-preview")
DEFAULT_VOICE = os.environ.get("GEMINI_VOICE", "Achird")

def get_gemini_client(custom_key: Optional[str] = None) -> Optional[genai.Client]:
    api_key = custom_key or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    return genai.Client(
        http_options={"api_version": "v1beta"},
        api_key=api_key,
    )

@app.get("/api/config")
async def get_config():
    """Returns initial configuration and status."""
    api_key = os.environ.get("GEMINI_API_KEY")
    masked_key = ""
    if api_key:
        masked_key = api_key[:6] + "..." + api_key[-4:] if len(api_key) > 10 else "***"
    return {
        "has_api_key": bool(api_key),
        "masked_key": masked_key,
        "default_model": DEFAULT_MODEL,
        "default_voice": DEFAULT_VOICE,
        "available_models": [
            {
                "id": "models/gemini-3.1-flash-live-preview",
                "name": "Gemini 3.1 Flash Live Preview",
                "description": "Our low-latency, audio-to-audio model optimized for real-time dialogue with acoustic nuance detection, numeric precision, and multimodal awareness."
            },
            {
                "id": "models/gemini-3.8-live",
                "name": "Gemini 3.8 Live Preview",
                "description": "Advanced real-time multimodal reasoning with extended context and adaptive pacing."
            },
            {
                "id": "models/gemini-2.5-flash-native-audio-latest",
                "name": "Gemini 2.5 Flash Native Audio",
                "description": "High-fidelity native audio streaming with fast conversational turnaround."
            }
        ],
        "voices": [
            "Achird",
            "Gacrux",
            "Pulcherrima",
            "Zubenelgenubi",
            "Vindemiatrix",
            "Zephyr",
            "Puck",
            "Charon",
            "Aoede",
            "Fenrir",
            "Kore",
            "Pegasus"
        ]
    }

@app.post("/api/key")
async def update_key(data: dict):
    new_key = data.get("api_key", "").strip()
    if not new_key:
        return JSONResponse({"error": "Key cannot be empty"}, status_code=400)
    os.environ["GEMINI_API_KEY"] = new_key
    with open(".env", "w") as f:
        f.write(f"GEMINI_API_KEY={new_key}\nGEMINI_LIVE_MODEL={DEFAULT_MODEL}\nGEMINI_VOICE={DEFAULT_VOICE}\n")
    return {"success": True, "masked_key": new_key[:6] + "..." + new_key[-4:]}

@app.websocket("/ws/live")
async def websocket_live_endpoint(websocket: WebSocket):
    await websocket.accept()

    client = get_gemini_client()
    if not client:
        await websocket.send_json({
            "type": "error",
            "message": "GEMINI_API_KEY not configured. Please set your key in Settings or .env file."
        })
        await websocket.close()
        return

    # Wait for setup message from client
    init_data = {}
    try:
        raw_init = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        init_data = json.loads(raw_init)
    except Exception:
        init_data = {}

    model = init_data.get("model") or DEFAULT_MODEL
    voice = init_data.get("voice") or DEFAULT_VOICE
    system_instruction = init_data.get("system_instruction") or None
    thinking_level = init_data.get("thinking_level", "MINIMAL").upper()
    media_resolution = init_data.get("media_resolution", "MEDIA_RESOLUTION_MEDIUM")

    print(f"[*] New Live session requested: Model={model}, Voice={voice}, Thinking={thinking_level}")

    # Build LiveConnectConfig
    connect_config_kwargs = {
        "response_modalities": ["AUDIO"],
        "media_resolution": media_resolution,
        "thinking_config": types.ThinkingConfig(thinking_level=thinking_level),
        "speech_config": types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        "input_audio_transcription": types.AudioTranscriptionConfig(),
        "output_audio_transcription": types.AudioTranscriptionConfig(),
        "context_window_compression": types.ContextWindowCompressionConfig(
            trigger_tokens=104857,
            sliding_window=types.SlidingWindow(target_tokens=52428),
        ),
    }

    if system_instruction and system_instruction.strip():
        connect_config_kwargs["system_instruction"] = types.Content(
            parts=[types.Part.from_text(text=system_instruction.strip())]
        )

    config = types.LiveConnectConfig(**connect_config_kwargs)

    try:
        async with client.aio.live.connect(model=model, config=config) as session:
            await websocket.send_json({
                "type": "connected",
                "model": model,
                "voice": voice
            })
            print("[*] Gemini Live WebSocket connected.")

            async def browser_to_gemini():
                """Reads user audio/video/text from browser and sends to Gemini"""
                try:
                    while True:
                        msg_text = await websocket.receive_text()
                        data = json.loads(msg_text)
                        msg_type = data.get("type")

                        if msg_type == "audio":
                            # PCM 16kHz chunk from browser mic
                            raw_b64 = data.get("data", "")
                            if raw_b64:
                                audio_bytes = base64.b64decode(raw_b64)
                                await session.send_realtime_input(audio={"data": audio_bytes, "mime_type": "audio/pcm"})

                        elif msg_type == "image":
                            # Camera or screen capture frame
                            raw_b64 = data.get("data", "")
                            mime_type = data.get("mime_type", "image/jpeg")
                            if raw_b64:
                                img_bytes = base64.b64decode(raw_b64)
                                await session.send_realtime_input(video={"data": img_bytes, "mime_type": mime_type})

                        elif msg_type == "text":
                            # User typed text message
                            text = data.get("text", "")
                            if text:
                                await session.send_client_content(
                                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=text)])],
                                    turn_complete=True
                                )

                        elif msg_type == "interrupt":
                            # Client requested playback halt
                            pass

                except WebSocketDisconnect:
                    pass
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"[!] Error in browser_to_gemini: {e}")

            async def gemini_to_browser():
                """Reads responses from Gemini and sends to browser"""
                try:
                    while True:
                        turn = session.receive()
                        async for response in turn:
                            # 1. Audio data from Gemini (24kHz PCM)
                            if response.data:
                                b64_audio = base64.b64encode(response.data).decode("utf-8")
                                await websocket.send_json({
                                    "type": "audio",
                                    "data": b64_audio
                                })

                            # 2. Text response / transcript
                            if response.text:
                                await websocket.send_json({
                                    "type": "text",
                                    "text": response.text
                                })

                            # 3. Check for server_content (transcriptions, parts, events)
                            if hasattr(response, "server_content") and response.server_content:
                                sc = response.server_content

                                # User speech-to-text transcript from Gemini
                                if getattr(sc, "input_transcription", None) and sc.input_transcription.text:
                                    await websocket.send_json({
                                        "type": "user_transcription",
                                        "text": sc.input_transcription.text,
                                        "finished": getattr(sc.input_transcription, "finished", False)
                                    })
                                elif getattr(sc, "interim_input_transcription", None) and sc.interim_input_transcription.text:
                                    await websocket.send_json({
                                        "type": "user_transcription",
                                        "text": sc.interim_input_transcription.text,
                                        "finished": False
                                    })

                                # Model speech-to-text transcript from output_transcription
                                if getattr(sc, "output_transcription", None) and sc.output_transcription.text:
                                    await websocket.send_json({
                                        "type": "text",
                                        "text": sc.output_transcription.text
                                    })
                                elif getattr(sc, "model_turn", None) and sc.model_turn.parts:
                                    for part in sc.model_turn.parts:
                                        if getattr(part, "text", None):
                                            await websocket.send_json({
                                                "type": "text",
                                                "text": part.text
                                            })

                                if getattr(sc, "interrupted", False):
                                    await websocket.send_json({"type": "interrupted"})
                                if getattr(sc, "turn_complete", False):
                                    await websocket.send_json({"type": "turn_complete"})

                        # End of current receive turn
                        await websocket.send_json({"type": "turn_complete"})

                except WebSocketDisconnect:
                    pass
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"[!] Error in gemini_to_browser: {e}")
                    await websocket.send_json({
                        "type": "error",
                        "message": str(e)
                    })

            # Run both bidirectional tasks concurrently
            tasks = [
                asyncio.create_task(browser_to_gemini()),
                asyncio.create_task(gemini_to_browser())
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()

    except Exception as e:
        print(f"[!] Live connect error: {e}")
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"Connection error: {str(e)}"
            })
        except Exception:
            pass


# Mount static directory
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"\n========================================================")
    print(f" Google AI Studio Gemini Flash Live Playground")
    print(f" Web UI running at: http://localhost:{port}")
    print(f"========================================================\n")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
