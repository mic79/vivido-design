# Zero-G WebXR Multiplayer 🚀

A production-ready zero-gravity WebXR multiplayer game built with modern web technologies. Experience realistic zero-gravity physics, VR controller thrusters, and real-time multiplayer in a immersive sci-fi space station environment.

## ✨ Features

### 🌌 Zero-Gravity Physics
- Realistic zero-gravity movement with Rapier physics engine
- Momentum-based movement system
- Object floating and collision interactions
- Dual-mesh collision system for optimized performance

### 🎮 VR Controller Support
- **Thruster Movement**: Use controller triggers for directional thrust
- **Object Grabbing**: Grip buttons to grab and manipulate floating objects
- **Haptic Feedback**: Immersive tactile responses
- **Hand Tracking**: Natural VR hand interactions (when available)
- **Particle Effects**: Visual thruster effects with real-time particles

### 🌐 Real-Time Multiplayer
- **P2P Networking**: Direct peer-to-peer connections using PeerJS
- **2-4 Players**: Support for small group multiplayer sessions
- **Room System**: Create or join rooms with simple room codes
- **Player Synchronization**: Real-time position and physics sync
- **Lag Compensation**: Smooth interpolation and prediction

### 🏛️ Immersive Environment
- **Sci-Fi Space Station**: Detailed modular corridor system
- **Dynamic Lighting**: Atmospheric point lights and shadows
- **Starfield Background**: Procedural star generation
- **Energy Fields**: Subtle environmental effects
- **Floating Objects**: 15+ interactive objects with realistic physics

### 🔊 Spatial Audio
- **3D Positional Audio**: HRTF-based spatial sound
- **Thruster Audio**: Dynamic audio based on thrust intensity
- **Impact Sounds**: Physics-based collision audio
- **Ambient Soundscape**: Immersive station atmosphere
- **VR Audio Optimization**: Low-latency audio for VR

### 🖥️ Cross-Platform Controls
- **VR Mode**: Full WebXR support for all major VR headsets
- **Desktop Mode**: Keyboard and mouse controls with pointer lock
- **Seamless Switching**: Automatic mode detection and switching

## 🛠️ Technical Stack

- **3D Graphics**: Three.js (CDN)
- **Physics**: Rapier 3D Physics Engine (CDN)
- **Networking**: PeerJS for P2P connections
- **VR Support**: WebXR with polyfill fallback
- **Audio**: Web Audio API with 3D spatial audio
- **No Bundlers**: Direct CDN imports for simplicity

## 🚀 Quick Start

### 1. Setup Project

```bash
# Clone or download the project
cd DodgeVR3

# No build process required - pure HTML/JS/CSS!
```

### 2. Start Development Server

```bash
# Using Python 3
python -m http.server 8000

# Or using Node.js
npx http-server -p 8000

# Or using PHP
php -S localhost:8000
```

### 3. Open in Browser

Navigate to `http://localhost:8000` in your browser.

### 4. Test VR (Optional)

1. Connect your VR headset
2. Enable developer mode on your headset
3. Use a VR-compatible browser (Chrome, Edge, Firefox Reality)
4. Click the "Enter VR" button in the application

## 🎯 Controls

### Desktop Controls
- **WASD** - Move in all directions
- **Mouse** - Look around (right-click for pointer lock)
- **Space** - Move up
- **Shift** - Move down
- **E** - Interact/grab objects
- **R** - Release grabbed objects
- **F** - Toggle pointer lock

### VR Controls
- **Trigger** - Activate thrusters (directional based on controller)
- **Grip** - Grab/release objects
- **Thumbstick** - Turn (if available)
- **Hand Tracking** - Natural hand interactions (when supported)

## 🌐 Multiplayer Usage

### Creating a Room
1. Click "Create Room" button
2. Share the generated room code with friends
3. Up to 4 players can join the same room

### Joining a Room
1. Enter the room code in the input field
2. Click "Join Room" button
3. Wait for connection confirmation

### Room Codes
- 6-character alphanumeric codes
- Case insensitive
- Automatic generation for hosts
- Direct P2P connections (no central server required)

## ⚙️ Configuration

### Audio Settings
- Adjust volume levels in `src/utils/Constants.js`
- Modify 3D audio parameters for different spatial effects
- Configure audio file paths

### Physics Settings
- Tweak zero-gravity parameters
- Adjust thrust forces and velocities
- Modify collision groups and materials

### Network Settings
- Change update rates for performance tuning
- Adjust connection timeouts
- Modify room ID length

### Performance Settings
- Configure LOD distances
- Adjust particle counts
- Set quality thresholds

## 🔧 Performance Optimization

The application includes automatic performance monitoring and optimization:

### Automatic Optimizations
- **Low FPS Detection**: Automatically reduces render quality
- **Memory Management**: Disposes unused resources
- **Shadow Optimization**: Disables shadows when needed
- **Particle Reduction**: Adjusts particle counts dynamically

### Manual Optimizations
- Reduce `SHADOW_MAP_SIZE` in Constants.js
- Lower `THRUSTER_PARTICLE_COUNT` for VR
- Decrease `FLOATING_OBJECTS_COUNT` for lower-end devices
- Adjust `UPDATE_RATE` for network optimization

## 📁 Project Structure

```
DodgeVR3/
├── index.html              # Main application entry
├── style.css               # Complete CSS styling
├── README.md               # This file
├── src/
│   ├── main.js             # Application entry point
│   ├── core/               # Core systems
│   │   ├── ZeroGWorld.js   # 3D world management
│   │   ├── PhysicsManager.js # Rapier physics integration
│   │   ├── NetworkManager.js # PeerJS networking
│   │   └── AudioManager.js  # 3D spatial audio
│   ├── systems/            # Input systems
│   │   ├── VRControllerSystem.js # VR input handling
│   │   └── DesktopControls.js    # Desktop input
│   └── utils/              # Utilities
│       ├── Constants.js    # Configuration constants
│       └── PerformanceMonitor.js # Performance tracking
├── audio/                  # Audio assets
│   ├── electric-hum.wav    # Thruster sound
│   ├── impact-cinematic-boom-5-352465.mp3 # Impact sound
│   └── submarine-sonar.mp3 # Ambient sound
└── assets/                 # 3D models (optional)
```

## 🎮 Implementation Phases

### ✅ Phase 1: Foundation (Complete)
- Core systems: main.js, ZeroGWorld.js, PhysicsManager.js
- Basic zero-gravity movement and physics
- Sci-fi space station environment
- Desktop controls working

### ✅ Phase 2: VR Integration (Complete)
- VRControllerSystem.js implementation
- Thruster movement with VR controllers
- Object grabbing system
- VR headset compatibility

### ✅ Phase 3: Multiplayer (Complete)
- NetworkManager.js implementation
- Player state synchronization
- Shared object interactions
- Room-based connection system

### ✅ Phase 4: Polish (Complete)
- 3D spatial audio system
- Thruster particle effects
- Performance monitoring and optimization
- Cross-platform compatibility

## 🔍 Debugging

### Performance Monitoring
- Press F12 to open developer tools
- Watch console for performance warnings
- Monitor FPS, memory usage, and network ping in the UI

### Network Debugging
- Check console for connection logs
- Verify room codes are entered correctly
- Ensure firewall allows WebRTC connections

### VR Debugging
- Confirm WebXR support in browser
- Check VR headset developer mode
- Verify headset is properly connected

## 🚀 Production Deployment

### CDN Dependencies
All dependencies are loaded from CDNs for production deployment:
- Three.js: `unpkg.com/three@0.158.0`
- Rapier Physics: `cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.11.2`
- PeerJS: `unpkg.com/peerjs@1.5.2`
- WebXR Polyfill: `unpkg.com/webxr-polyfill@2.0.3`

### Hosting Requirements
- **HTTPS Required**: WebXR and getUserMedia require secure contexts
- **WebRTC Support**: For P2P networking
- **Static File Hosting**: No server-side processing required

### Recommended Hosting Platforms
- **Netlify**: Easy drag-and-drop deployment
- **Vercel**: GitHub integration
- **GitHub Pages**: Free hosting for open source
- **AWS S3 + CloudFront**: Scalable static hosting

## 🐛 Known Issues & Limitations

### Browser Compatibility
- Chrome/Edge: Full WebXR support
- Firefox: Limited WebXR support
- Safari: No WebXR support (desktop fallback only)

### VR Headset Support
- Meta Quest 2/3: Full support
- Valve Index: Full support
- HTC Vive: Full support
- Windows Mixed Reality: Partial support

### Network Limitations
- P2P connections may have issues with restrictive firewalls
- No dedicated server for matchmaking
- Maximum 4 players per room

## 🔮 Future Enhancements

### Potential Additions
- **Game Modes**: Capture the flag, racing, exploration
- **Voice Chat**: WebRTC voice communication
- **Advanced Physics**: Rope/cable physics, liquid simulation
- **More Environments**: Multiple space station designs
- **AI Bots**: Single-player mode with AI companions
- **Customization**: Player avatars and color schemes

### Technical Improvements
- **Dedicated Signaling Server**: For better matchmaking
- **State Persistence**: Save/load game states
- **Mobile VR Support**: WebXR on mobile browsers
- **Hand Tracking Enhancements**: More natural interactions

## 📄 License

This project is open source and available under the MIT License.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

## 🌟 Credits

- **Physics**: Rapier Physics Engine
- **3D Graphics**: Three.js
- **Networking**: PeerJS
- **Audio**: Web Audio API
- **VR**: WebXR Device API

---

**Ready to experience zero gravity? Launch the application and start floating! 🚀✨** 