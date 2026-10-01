# Gemini Flash Live Interactive Assistant

Real-time audio, video (webcam or screen share), and text streaming with Google Gemini Live API.

## Requirements

1. **Hardware**:
   - Working Microphone (Audio Input)
   - Working Speaker/Headphones (Audio Output)
   - Webcam (Optional, for `--mode camera`)
   - Display/Screen (For `--mode screen`)

2. **API Key**:
   - A Gemini API Key from [Google AI Studio](https://aistudio.google.com/apikey).

## Setup Instructions

### 1. Virtual Environment & Dependencies
Activate the virtual environment:
```powershell
.\venv\Scripts\Activate.ps1
```

Install required packages:
```powershell
pip install -r requirements.txt
```

### 2. Configure Environment Variables
Create a `.env` file from `.env.example`:
```powershell
Copy-Item .env.example .env
```
Open `.env` and paste your Gemini API key:
```env
GEMINI_API_KEY=AIzaSy...
```

### 3. Run the Web UI (Google AI Studio Playground Replica)

Start the web application:
```powershell
python app.py
```
Or with uvicorn:
```powershell
.\venv\Scripts\uvicorn.exe app:app --port 8000
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser (Chrome or Edge recommended).

#### Web UI Features:
- **Exact Google AI Studio Dark Theme Layout**:
  - **Left Sidebar**: Explore (Playground, History), Build, Manage, and account profile.
  - **Center Playground**: Real-time conversation stream with embedded audio players for each turn, live waveform visualizer, quick prompt chips, and bottom capsule dock.
  - **Right Sidebar (Run settings)**: Model selector (`gemini-3.1-flash-live-preview`, `gemini-3.8-live`), System instructions, Voice selector (`Zephyr`, `Puck`, `Charon`, etc.), Thinking level, Media resolution, and Live Oscilloscope.
  - **Audio & Video Streaming**:
    - **Microphone**: Click the Mic button to talk directly to Gemini.
    - **Camera**: Click the Camera button to stream your webcam feed (with Picture-in-Picture preview).
    - **Screen Share**: Click the Screen button to stream your desktop/screen.
    - **Run Ctrl ↵**: Type any text prompt and press Enter or click Run.

---

### 4. Run via Terminal / CLI Mode (Optional)

- **With Camera**:
  ```powershell
  python main.py --mode camera
  ```

- **With Screen Capture**:
  ```powershell
  python main.py --mode screen
  ```

- **Audio Only**:
  ```powershell
  python main.py --mode none
  ```
