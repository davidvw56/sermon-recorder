# Sermon Recorder & Analyzer

## What It Does
A single-file browser app that records sermons, transcribes them, and uses Claude AI to generate a comprehensive analysis package:

- **Elevator Pitch** — 1-2 sentence conversational summary
- **3-5 Main Points** — key themes and teachings
- **12 Key Quotes** — spanning the full arc of the sermon (opening to closing)
- **2-3 Bible Verses** — that speak directly to the sermon's message
- **Prayer** — inspired by the specific themes preached

## Live URL
**https://davidvw56.github.io/sermon-recorder/sermon-recorder.html**

GitHub repo: https://github.com/davidvw56/sermon-recorder

## How to Use
1. Open the URL in Chrome (desktop or Android)
2. Tap **Settings** and enter your Anthropic API key
3. Tap the red record button, record the sermon, tap again to stop
4. Tap **Analyze Sermon** (appears after recording stops)
5. Results appear with Copy and Download options for each section

## Transcription Engines
- **Browser (Free)** — uses Web Speech API, real-time transcription as you speak. Works in Chrome and Edge. Default option.
- **Whisper (Accurate)** — sends audio to OpenAI Whisper API after recording. Requires an OpenAI API key entered in Settings.

## Tech Stack
- Single HTML file, no build tools, no dependencies
- MediaRecorder API for audio capture
- Web Speech API / OpenAI Whisper for transcription
- Claude API (claude-sonnet-4-6) for analysis
- API keys stored in browser localStorage

## Design
Uses the MIE (Market Intelligence Engine) Design System:
- Dark navy blue background (#0F2640)
- Lora (serif) for display type, Source Sans 3 for body/UI
- Teal (#2A7FA5) as primary accent, gold (#B8860B) for scripture references
- 4px left-border accent strips on result cards
- Flat 4px border-radius throughout, no box-shadows
- Minimal single-screen layout — just the record button and analyze

## Build History
1. **Initial build** — full-featured app with green/cream theme, hero band, transcript editor, settings panel
2. **MIE redesign** — applied institutional design system (colors, typography, layout patterns)
3. **Dark mode simplification** — dark navy background, removed hero band and transcript box, compressed to single-screen recorder + analyze button flow
4. **Deployed to GitHub Pages** — davidvw56/sermon-recorder repo, GitHub Pages enabled on main branch
