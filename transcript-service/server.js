const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;
const SERVICE_SECRET = process.env.SERVICE_SECRET; // shared secret with Worker
const PORT = process.env.PORT || 3001;
const TMP_DIR = '/tmp';

// CORS — only our Worker calls this, but allow health checks
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!SERVICE_SECRET) return next(); // no secret configured = open (dev mode)
  if (auth === `Bearer ${SERVICE_SECRET}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Health check
app.get('/health', (req, res) => {
  const ytdlp = safeExec('yt-dlp --version');
  const ffmpeg = safeExec('ffmpeg -version 2>&1 | head -1');
  res.json({
    status: 'ok',
    ytdlp: ytdlp.trim(),
    ffmpeg: ffmpeg.split('\n')[0].trim(),
    openai: !!OPENAI_KEY
  });
});

// Main endpoint: YouTube URL → transcript
app.post('/transcribe', authenticate, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const audioPath = path.join(TMP_DIR, `audio_${videoId}.m4a`);
  const trimmedPath = path.join(TMP_DIR, `trimmed_${videoId}.m4a`);

  try {
    console.log(`[${videoId}] Starting transcription...`);

    // Step 1: Download audio (48kbps m4a, smallest format)
    console.log(`[${videoId}] Downloading audio...`);
    cleanup(audioPath, trimmedPath);

    // Try multiple client strategies to avoid bot detection on cloud servers
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const strategies = [
      `yt-dlp -f 139 --no-warnings --extractor-args "youtube:player_client=mediaconnect" -o "${audioPath}" "${ytUrl}"`,
      `yt-dlp -f 139 --no-warnings --extractor-args "youtube:player_client=ios,web_creator" -o "${audioPath}" "${ytUrl}"`,
      `yt-dlp -f "ba[abr<=64]/ba" --no-warnings --extractor-args "youtube:player_client=mediaconnect" -o "${audioPath}" "${ytUrl}"`,
      `yt-dlp -f "ba[abr<=64]/ba" --no-warnings -o "${audioPath}" "${ytUrl}"`,
    ];

    let downloaded = false;
    for (const cmd of strategies) {
      try {
        console.log(`[${videoId}] Trying: ${cmd.split('-o')[0].trim()}`);
        execSync(cmd, { timeout: 120000, stdio: 'pipe' });
        if (fs.existsSync(audioPath)) { downloaded = true; break; }
      } catch (e) {
        console.log(`[${videoId}] Strategy failed: ${e.message.split('\n')[0]}`);
        cleanup(audioPath);
      }
    }

    if (!downloaded || !fs.existsSync(audioPath)) {
      return res.status(500).json({ error: 'Failed to download audio. YouTube may be blocking this server.' });
    }

    const fullSize = fs.statSync(audioPath).size;
    console.log(`[${videoId}] Downloaded: ${(fullSize / 1024 / 1024).toFixed(1)}MB`);

    // Step 2: Extract last 60 minutes with ffmpeg (if file > 25MB)
    let whisperInput = audioPath;

    if (fullSize > 24 * 1024 * 1024) {
      console.log(`[${videoId}] Trimming to last 60 minutes...`);
      const durationStr = safeExec(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`
      ).trim();
      const duration = parseFloat(durationStr);

      if (isNaN(duration)) {
        return res.status(500).json({ error: 'Could not determine audio duration' });
      }

      const startSec = Math.max(0, duration - 3600); // last 60 min
      const startTime = formatTime(startSec);
      console.log(`[${videoId}] Duration: ${(duration/60).toFixed(1)}min, trimming from ${startTime}`);

      execSync(
        `ffmpeg -y -i "${audioPath}" -ss ${startTime} -c copy "${trimmedPath}"`,
        { timeout: 60000, stdio: 'pipe' }
      );

      whisperInput = trimmedPath;
      const trimmedSize = fs.statSync(trimmedPath).size;
      console.log(`[${videoId}] Trimmed: ${(trimmedSize / 1024 / 1024).toFixed(1)}MB`);

      if (trimmedSize > 25 * 1024 * 1024) {
        // Still too big — take less time
        const maxMinutes = Math.floor((25 * 1024 * 1024 / fullSize) * (duration / 60));
        const newStart = Math.max(0, duration - maxMinutes * 60);
        console.log(`[${videoId}] Still too large, trimming to last ${maxMinutes} minutes...`);
        execSync(
          `ffmpeg -y -i "${audioPath}" -ss ${formatTime(newStart)} -c copy "${trimmedPath}"`,
          { timeout: 60000, stdio: 'pipe' }
        );
      }
    }

    const finalSize = fs.statSync(whisperInput).size;
    console.log(`[${videoId}] Sending ${(finalSize / 1024 / 1024).toFixed(1)}MB to Whisper...`);

    // Step 3: Send to Whisper API
    const openai = new OpenAI({ apiKey: OPENAI_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(whisperInput),
      model: 'whisper-1',
      response_format: 'text'
    });

    console.log(`[${videoId}] Transcription complete: ${transcription.length} chars`);

    // Cleanup temp files
    cleanup(audioPath, trimmedPath);

    res.json({
      transcript: transcription,
      videoId,
      source: 'whisper'
    });

  } catch (err) {
    console.error(`[${videoId}] Error:`, err.message);
    cleanup(audioPath, trimmedPath);
    res.status(500).json({ error: err.message });
  }
});

function extractVideoId(url) {
  const patterns = [
    /(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { timeout: 10000, stdio: 'pipe' }).toString();
  } catch {
    return 'unavailable';
  }
}

function cleanup(...files) {
  files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
}

app.listen(PORT, () => {
  console.log(`Transcript service running on port ${PORT}`);
});
