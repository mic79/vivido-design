# WebXR Zero-G Environment - AmmoJS Edition

A modular WebXR zero-gravity environment built with A-Frame and AmmoJS physics. This project demonstrates advanced VR locomotion, physics interactions, and modular code organization for WebXR development.

## 🚀 Features

- **Zero Gravity Physics**: Realistic space environment with AmmoJS physics engine
- **VR Locomotion**: Thruster-based movement and grab-and-push mechanics
- **Interactive Objects**: Grabbable balls and surfaces with realistic physics
- **Collision Detection**: Player collision with environment using capsule physics body
- **Modular Architecture**: Clean separation of concerns across multiple modules
- **Cross-Platform VR**: Works with Oculus, Vive, Windows Mixed Reality, and more

## 📁 Project Structure

```
DodgeVR2/
├── index.html                 # Main HTML file with scene setup
├── js/
│   ├── utils.js              # Utility functions and helper classes
│   ├── physics.js            # AmmoJS physics world and management
│   ├── interaction.js        # VR hand tracking and interaction system
│   ├── player.js             # Zero-gravity player controller
│   ├── balls.js              # Grabbable ball physics and mechanics
│   └── environment.js        # Static surfaces and collision objects
└── README.md                 # This file
```

## 🔧 Core Modules

### 1. Physics System (`physics.js`)
- AmmoJS world initialization with zero gravity
- Collision detection and response
- Shape creation utilities (box, sphere, cylinder, capsule)
- Performance monitoring and debug tools

### 2. Player Controller (`player.js`)
- Zero-gravity VR locomotion
- Thruster-based movement system
- Collision detection with environment
- Emergency braking and velocity damping

### 3. Interaction System (`interaction.js`)
- VR controller input handling
- Hand tracking and proximity detection
- Grabbing mechanics for objects and surfaces
- Haptic feedback integration

### 4. Ball Physics (`balls.js`)
- Grabbable balls with realistic throwing mechanics
- Magnus effect for spinning ball curves
- Velocity tracking and momentum calculation
- Impact detection and sound effects

### 5. Environment System (`environment.js`)
- Static surface collision
- Grabbable environment objects
- Proximity indicators for interactive elements
- Environmental hazards and effects

### 6. Utilities (`utils.js`)
- Vector3 conversion between THREE.js and AmmoJS
- Debug logging and performance monitoring
- Math utilities for zero-gravity physics
- Global state management

## 🎮 Controls

### VR Controllers
- **Grip**: Grab objects and surfaces
- **Trigger**: Activate thrusters for movement
- **Thumbstick Click**: Emergency brake
- **A Button**: Debug actions (when debug mode enabled)

### Keyboard (Desktop Testing)
- **C**: Toggle collision visualization
- **D**: Toggle debug information display

## 🛠️ Setup and Installation

1. **Clone or download** the project files
2. **Serve the files** using a local web server (required for WebXR):
   ```bash
   # Using Python 3
   python -m http.server 8000
   
   # Using Node.js http-server
   npx http-server
   
   # Using PHP
   php -S localhost:8000
   ```
3. **Access via HTTPS** (required for WebXR):
   - Use ngrok: `ngrok http 8000`
   - Or access via `localhost` in development
4. **Open in a WebXR-compatible browser**:
   - Chrome/Edge with WebXR flags enabled
   - Firefox with WebXR enabled
   - Or use a VR browser directly

## 🔬 Technical Details

### Physics Engine
- **AmmoJS**: Bullet Physics compiled to JavaScript
- **Zero Gravity**: Custom physics simulation for space environment
- **Collision Groups**: Organized collision filtering system
- **Performance**: Optimized for 60+ FPS in VR

### VR Integration
- **A-Frame 1.7.0**: WebXR framework for VR/AR experiences
- **Multi-Platform**: Support for major VR headsets
- **Hand Tracking**: Precise controller position and gesture recognition
- **Haptic Feedback**: Force feedback for enhanced immersion

### Code Organization
- **Modular Design**: Each system in its own file
- **Event-Driven**: Components communicate via events
- **Extensible**: Easy to add new features and objects
- **Debug-Friendly**: Comprehensive logging and visualization tools

## 🎯 Key Interactions

### Zero-Gravity Movement
1. **Thrusters**: Hold triggers to activate hand-mounted thrusters
2. **Grab & Push**: Grip surfaces and push off for momentum
3. **Emergency Brake**: Click thumbsticks to rapidly decelerate

### Object Manipulation
1. **Ball Grabbing**: Grip near balls to pick them up
2. **Throwing**: Release grip while moving hand to throw
3. **Spin Effects**: Twist hand while throwing for curved trajectories

### Environmental Interaction
1. **Surface Grabbing**: Grip boxes, cylinders, and other surfaces
2. **Collision Feedback**: Visual and haptic feedback on contact
3. **Proximity Indicators**: Visual cues when near grabbable objects

## 🔧 Development Notes

### Performance Optimization
- Physics simulation capped at 240Hz for stability
- Frame rate independent damping and forces
- Efficient collision detection with spatial partitioning
- Memory management for AmmoJS objects

### Browser Compatibility
- Requires WebXR support (Chrome 79+, Firefox 98+)
- HTTPS required for WebXR features
- WebGL 2.0 support recommended

### Debugging
- Press `C` to toggle collision visualization
- Check browser console for detailed physics logging
- Use `window.ZeroGState.debugMode = true` for enhanced debugging

## 🚀 Future Enhancements

- **Multiplayer Support**: Real-time networking with PeerJS
- **Advanced AI**: Intelligent bot opponents
- **Game Mechanics**: Scoring system and objectives
- **Visual Effects**: Particle systems and advanced shaders
- **Audio**: Spatial audio and sound effects
- **Haptic Improvements**: Enhanced force feedback

## 📝 License

This project is provided as an educational example for WebXR development. Feel free to use and modify for your own projects.

## 🙏 Acknowledgments

- **A-Frame Team**: For the excellent WebXR framework
- **Bullet Physics**: For the robust physics simulation
- **Original Project**: Based on the sophisticated zero-gravity WebXR environment concept 