# Vosk.js Implementation Guide for Quest Support

## Current Status
The app currently uses **Web Speech API** which does **NOT work on Meta Quest browsers**. To make it work on Quest, you need to implement **Vosk.js** for offline speech recognition.

## Why Vosk?
- ✅ Works on Meta Quest / Meta Browser
- ✅ Works offline (no internet needed)
- ✅ Free and open source
- ✅ Supports Spanish, French, German, Dutch
- ⚠️ ~50MB per language model
- ⚠️ Slightly less accurate than Web Speech API
- ⚠️ Requires WASM support (all modern browsers)

## Implementation Steps

### 1. Add Vosk.js Library
```html
<script src="https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js"></script>
```

### 2. Download Language Models
Download small models (~40-50MB each) from:
https://alphacephei.com/vosk/models

Recommended models:
- **Spanish**: `vosk-model-small-es-0.42` (39MB)
- **French**: `vosk-model-small-fr-0.22` (41MB)
- **German**: `vosk-model-small-de-0.15` (45MB)
- **Dutch**: `vosk-model-small-nl-0.22` (39MB)

Place in: `languageVR/assets/vosk-models/`

### 3. Model Structure
```
languageVR/
├── assets/
│   └── vosk-models/
│       ├── es/
│       │   ├── am/
│       │   ├── conf/
│       │   └── graph/
│       ├── fr/
│       ├── de/
│       └── nl/
```

### 4. Initialize Vosk
```javascript
// In LanguageApp.init()
async initVoskRecognition() {
  console.log('[Vosk] Loading models...');
  
  try {
    // Load Vosk
    await Vosk.createModel('assets/vosk-models/' + this.currentLanguageCode);
    
    this.recognizer = new Vosk.KaldiRecognizer(model, 16000);
    
    // Get microphone stream
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    
    // Create processor
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Convert to Int16
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        int16Data[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
      }
      
      // Send to Vosk
      const result = this.recognizer.acceptWaveform(int16Data);
      if (result) {
        const text = JSON.parse(this.recognizer.result()).text;
        if (text) {
          this.checkAnswer(text, 1.0);
        }
      }
    };
    
    source.connect(processor);
    processor.connect(audioContext.destination);
    
    console.log('[Vosk] ✓ Ready');
  } catch (error) {
    console.error('[Vosk] Error:', error);
  }
}
```

### 5. Language Mapping
```javascript
getVoskLanguageCode(lang) {
  const map = {
    'es-ES': 'es',
    'fr-FR': 'fr',
    'de-DE': 'de',
    'nl-NL': 'nl'
  };
  return map[lang] || 'es';
}
```

### 6. Detection Logic
```javascript
initSpeechRecognition() {
  // Check if Web Speech API is available (desktop)
  if (window.SpeechRecognition || window.webkitSpeechRecognition) {
    this.initWebSpeechAPI();
  } else {
    // Fallback to Vosk for Quest
    this.initVoskRecognition();
  }
}
```

### 7. Show Loading Progress
```javascript
// Show model loading progress in VR UI
this.updateVRText('vr-instruction-text', '⏳ Loading speech models... 50%');
```

## Alternative: Whisper.cpp in Browser
For better accuracy, consider **whisper.cpp** compiled to WASM:
- https://github.com/ggerganov/whisper.cpp
- Higher quality than Vosk
- Larger models (~70-150MB)
- Slower processing

## Quick Test
To test if Vosk works:
```javascript
// In browser console
navigator.mediaDevices.getUserMedia({ audio: true })
  .then(() => console.log('✅ Mic access granted'))
  .catch(e => console.error('❌ Mic blocked:', e));
```

## References
- Vosk Documentation: https://alphacephei.com/vosk/
- Vosk.js GitHub: https://github.com/alphacep/vosk-browser
- Models: https://alphacephei.com/vosk/models

## Estimated Implementation Time
- **Basic Vosk integration**: 2-3 hours
- **All 4 languages**: +2 hours
- **UI/UX polish**: +1 hour
- **Testing on Quest**: +2 hours

**Total**: ~7-10 hours for full Vosk implementation

## Need Help?
The implementation is straightforward but requires:
1. Downloading the models (manual step)
2. Integrating the Vosk.js library
3. Converting audio to the correct format
4. Handling model switching between languages

This guide provides the foundation - the actual code would need to be integrated into the existing `LanguageApp` structure.

