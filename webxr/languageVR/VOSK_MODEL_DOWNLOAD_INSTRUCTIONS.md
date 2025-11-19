# Vosk Model Download Instructions

## Quick Start

To make the app work on Meta Quest, you need to download the Vosk language models.

## Step 1: Download Models

Download these models from **https://alphacephei.com/vosk/models**

### Spanish (39 MB)
**Model**: `vosk-model-small-es-0.42`
**Link**: https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip

### French (41 MB)
**Model**: `vosk-model-small-fr-0.22`
**Link**: https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip

### German (45 MB)
**Model**: `vosk-model-small-de-0.15`
**Link**: https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip

### Dutch (39 MB)
**Model**: `vosk-model-small-nl-0.22`
**Link**: https://alphacephei.com/vosk/models/vosk-model-small-nl-0.22.zip

## Step 2: Extract and Place Models

After downloading, extract each ZIP file and place them in this structure:

```
languageVR/
├── assets/
│   └── vosk-models/
│       ├── es/
│       │   ├── am/
│       │   ├── conf/
│       │   ├── graph/
│       │   └── model
│       ├── fr/
│       │   ├── am/
│       │   ├── conf/
│       │   ├── graph/
│       │   └── model
│       ├── de/
│       │   ├── am/
│       │   ├── conf/
│       │   ├── graph/
│       │   └── model
│       └── nl/
│           ├── am/
│           ├── conf/
│           ├── graph/
│           └── model
```

### Detailed Steps:

1. **Create the directory structure:**
   ```
   languageVR/assets/vosk-models/es/
   languageVR/assets/vosk-models/fr/
   languageVR/assets/vosk-models/de/
   languageVR/assets/vosk-models/nl/
   ```

2. **Extract Spanish model:**
   - Unzip `vosk-model-small-es-0.42.zip`
   - You'll see a folder called `vosk-model-small-es-0.42`
   - Copy the contents (am, conf, graph folders) into `languageVR/assets/vosk-models/es/`

3. **Extract French model:**
   - Unzip `vosk-model-small-fr-0.22.zip`
   - Copy contents into `languageVR/assets/vosk-models/fr/`

4. **Extract German model:**
   - Unzip `vosk-model-small-de-0.15.zip`
   - Copy contents into `languageVR/assets/vosk-models/de/`

5. **Extract Dutch model:**
   - Unzip `vosk-model-small-nl-0.22.zip`
   - Copy contents into `languageVR/assets/vosk-models/nl/`

## Step 3: Verify Structure

Your final structure should look like this:

```
languageVR/
├── index2.html
├── assets/
│   ├── vosk-models/
│   │   ├── es/
│   │   │   ├── am/
│   │   │   │   └── final.mdl
│   │   │   ├── conf/
│   │   │   │   ├── mfcc.conf
│   │   │   │   └── model.conf
│   │   │   ├── graph/
│   │   │   │   ├── Gr.fst
│   │   │   │   ├── HCLr.fst
│   │   │   │   └── disambig_tid.int
│   │   │   ├── ivector/
│   │   │   └── README
│   │   ├── fr/
│   │   │   └── (same structure)
│   │   ├── de/
│   │   │   └── (same structure)
│   │   └── nl/
│   │       └── (same structure)
│   ├── bagan_-_khayiminga_temple_interior.glb
│   ├── library_of_celsus_-_crowdsourced_photogrammetry.glb
│   └── hintze_hall.glb
```

## Step 4: Test

1. Open `index2.html` in a browser (Chrome/Edge recommended for testing)
2. You should see a loading screen saying "Loading Speech Models..."
3. If models are correctly placed, it will load and you can start practicing
4. If models are missing, you'll see an error message

## Step 5: Deploy to Quest

### Option A: GitHub Pages
1. Commit the models to your repository
   ```bash
   git add languageVR/assets/vosk-models/
   git commit -m "Add Vosk speech recognition models"
   git push
   ```
2. Access via Quest browser at your GitHub Pages URL

### Option B: Local Network
1. Run a local server:
   ```bash
   cd languageVR
   python -m http.server 8000
   ```
2. Find your PC's IP address (e.g., `192.168.1.100`)
3. On Quest, open Browser and navigate to `http://192.168.1.100:8000/index2.html`

## Troubleshooting

### "Could not load speech recognition models"
- Check that folder names are exactly: `es`, `fr`, `de`, `nl` (lowercase)
- Check that the `am`, `conf`, `graph` folders exist inside each language folder
- Check browser console (F12) for specific error messages

### Models load but recognition doesn't work
- Check microphone permissions in Quest browser
- Speak clearly and loudly
- Check console for error messages

### Very slow loading
- First load downloads ~160MB total, can take 1-2 minutes on Quest
- Models are cached afterwards, subsequent loads are instant
- Consider uploading to a fast server (GitHub Pages, Netlify, etc.)

## Alternative: Start with One Language

If you want to test quickly, start with just Spanish:

1. Download only `vosk-model-small-es-0.42.zip`
2. Extract to `languageVR/assets/vosk-models/es/`
3. Load `index2.html`
4. The app will work for Spanish only
5. Download other languages later

## Notes

- **Total size**: ~164 MB for all 4 languages
- **Loading time** (first visit): 1-2 minutes on Quest
- **Loading time** (cached): ~2-5 seconds
- **Accuracy**: Slightly lower than Web Speech API, but works offline
- **Recommended**: Use PC browser for testing before deploying to Quest

## Need Help?

Check the browser console (F12 on PC, use Oculus Developer Hub for Quest) for detailed error messages.

