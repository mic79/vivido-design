# 🗣️ WebXR Language Practice VR

A fully immersive VR language learning application that lets you practice real conversations with AI tutors in Spanish, French, and German.

## ✨ Features

- **Interactive VR NPCs**: Full-body avatars using Mixamo rigging system
- **Speech Recognition**: Real-time speech-to-text using Web Speech API
- **Speech Synthesis**: NPCs speak phrases for you to repeat
- **Multiple Languages**: Spanish, French, and German
- **4 Scenarios**: Greetings, Restaurant, Shopping, and Directions
- **Real-time Feedback**: Instant scoring and pronunciation feedback
- **Progress Tracking**: Score system with visual feedback
- **Completely Free**: No backend, no API costs, GitHub Pages compatible

## 🚀 Quick Start

### Option 1: GitHub Pages (Recommended)

1. Fork or clone this repository
2. Enable GitHub Pages in repository settings
3. Access at: `https://yourusername.github.io/your-repo/languageVR/`

### Option 2: Local Development

1. Start a local web server (required for WebXR):
```bash
# Using Python 3
python -m http.server 8000

# Using Node.js
npx http-server -p 8000
```

2. Open browser to: `http://localhost:8000/languageVR/`

## 🎮 How to Use

### Desktop Mode (Testing)
1. Open the app in a browser
2. Click "Enter VR Experience"
3. Use the UI on the left to:
   - Select a language (Spanish/French/German)
   - Choose a scenario
   - See your current score

### VR Mode (Full Experience)
1. Put on your VR headset (Meta Quest, PCVR, etc.)
2. Open the app in the VR browser
3. Click "Enter VR Experience"
4. Listen to the NPC tutor speak a phrase
5. Repeat the phrase clearly into your microphone
6. Get instant feedback on your pronunciation
7. **Right thumbstick**: Rotate the NPC tutor

## 🎯 Scenarios & Phrases

### Greetings (6 phrases)
- Basic introductions
- Asking names
- Polite greetings

### Restaurant (4+ phrases)
- Ordering food
- Asking for the bill
- Making reservations

### Shopping (3+ phrases)
- Asking prices
- Colors and sizes
- Making purchases

### Directions (3+ phrases)
- Asking for locations
- Following directions
- Navigation phrases

## 🛠️ Technical Details

### Architecture
- **Frontend**: A-Frame 1.7.0 (WebXR framework)
- **3D Models**: Mixamo rigged character (Y Bot.fbx)
- **Speech Recognition**: Web Speech API (browser-native)
- **Speech Synthesis**: SpeechSynthesis API (browser-native)
- **Physics**: Three.js for 3D math
- **Hosting**: Static files (GitHub Pages compatible)

### Browser Support
- ✅ Chrome/Edge (Best support)
- ✅ Meta Quest Browser
- ✅ Safari (iOS 14.5+)
- ⚠️ Firefox (Limited speech support)

### Requirements
- WebXR-capable device or browser
- Microphone access for speech recognition
- Internet connection (for Web Speech API)
- HTTPS (provided by GitHub Pages or localhost)

## 📁 File Structure

```
languageVR/
├── index.html          # Main application
└── README.md          # This file

Required from parent directory:
└── BoltVR/
    └── assets/
        └── Y Bot.fbx  # Mixamo character model
```

## 🎨 Customization

### Adding New Phrases

Edit the `phrases` object in `index.html`:

```javascript
phrases: {
  'your_scenario': {
    'es-ES': [
      { text: 'Tu frase aquí', translation: 'Your phrase here', difficulty: 1 }
    ]
  }
}
```

### Changing NPC Appearance

Modify the `mixamo-body` component color:

```html
<a-entity id="npc-tutor" 
          mixamo-body="isMirror: true; color: #FF6B6B">
```

### Adding New Languages

1. Add language to buttons:
```html
<button class="lang-btn" data-lang="it-IT" data-name="Italian">🇮🇹 Italian</button>
```

2. Add phrases for that language code in the `phrases` object

## 🐛 Troubleshooting

### Speech Recognition Not Working
- **Check browser support**: Chrome/Edge work best
- **Allow microphone permission**: Check browser permissions
- **Use HTTPS**: Required for microphone access
- **Check console**: Look for error messages

### VR Not Starting
- **Compatible device**: Need WebXR-capable browser
- **HTTPS required**: Use GitHub Pages or localhost
- **Check console**: Look for WebXR errors

### NPC Body Not Showing
- **Check model path**: Ensure `../BoltVR/assets/Y Bot.fbx` exists
- **Console errors**: Look for FBXLoader errors
- **File permissions**: Ensure model file is accessible

### Audio Issues
- **Volume**: Check system and browser volume
- **Autoplay policy**: Some browsers block audio until user interaction
- **Speech synthesis**: Available voices vary by browser/OS

## 🔒 Privacy

- **Web Speech API**: Sends audio to browser vendor servers (Google/Apple)
- **No data stored**: All processing happens client-side
- **No tracking**: No analytics or user tracking
- **No backend**: Completely static website

## 📚 Educational Approach

Based on proven language learning principles:

1. **Immersive Context**: 3D environments reinforce vocabulary
2. **Repetition**: Practice phrases until mastered
3. **Immediate Feedback**: Real-time pronunciation scoring
4. **Progressive Difficulty**: Scenarios range from basic to advanced
5. **Natural Interaction**: Conversational practice with NPCs
6. **Gamification**: Score system encourages continued practice

## 🚧 Future Enhancements

Potential improvements:
- [ ] Offline mode with Vosk speech recognition
- [ ] Lip-sync animations for NPCs
- [ ] More languages (Italian, Portuguese, Japanese)
- [ ] Grammar lessons
- [ ] Conversation branching
- [ ] Multiplayer mode (practice with friends)
- [ ] Progress persistence (localStorage)
- [ ] Achievement system
- [ ] Custom phrase lists

## 📄 License

This project is open source and available for educational purposes.

## 🙏 Credits

- **A-Frame**: WebXR framework
- **Mixamo**: 3D character models and rigging
- **Web Speech API**: Browser-native speech recognition
- **Three.js**: 3D mathematics library

## 💡 Tips for Best Results

1. **Speak clearly**: Enunciate words distinctly
2. **Quiet environment**: Reduce background noise
3. **Good microphone**: Use quality audio input
4. **Match intonation**: Try to mimic the NPC's pronunciation
5. **Practice regularly**: Consistent practice improves retention
6. **VR headset**: Full immersion enhances learning

## 🤝 Contributing

Contributions are welcome! Areas for improvement:
- Additional language phrases
- New scenarios
- UI/UX enhancements
- Bug fixes
- Documentation

---

**Enjoy learning languages in VR! 🌍🎓**



