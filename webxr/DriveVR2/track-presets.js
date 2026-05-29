/**
 * DriveVR2 track presets and personal slot storage.
 * Custom slots store only the compact ?track= URL param string (not full geometry).
 */
const TrackManager = {
    STORAGE_KEY_PREFIX: 'drivevr2_track_slot_',
    MAX_PERSONAL_SLOTS: 5,

    currentTrackName: 'Default Circuit',
    currentTrackSource: 'preset',

    presetTracks: [
        {
            id: 'default',
            name: 'Default Circuit',
            description: 'Built-in mountain circuit',
            trackParam:
                '-48.00,0.00,80.00|-8.01,1.00,80.00|24.00,1.00,32.00|48.00,0.00,8.00|' +
                '88.00,1.00,16.00|104.00,1.00,48.00|72.00,6.00,72.00|32.00,6.00,56.00|' +
                '8.00,6.00,8.00|0.00,6.00,-40.00|16.00,1.00,-72.00|64.00,1.00,-80.00|' +
                '104.00,1.00,-40.00|112.00,6.00,16.00|80.00,15.00,56.00|16.00,9.00,64.00|' +
                '-32.00,16.00,56.00|-64.00,6.00,8.00|-72.00,6.00,-32.00|-48.00,6.00,-72.00|' +
                '0.00,6.00,-80.00|56.00,6.00,-56.00|40.00,12.00,0.00|0.00,12.00,16.00|' +
                '-40.00,6.00,0.00|-56.00,12.00,-40.00|-64.00,12.00,-72.00|-88.00,12.00,-80.00|' +
                '-112.00,6.00,-56.00|-104.00,6.00,-16.00|-112.00,1.00,24.00|-87.08,1.00,79.60|' +
                '-48.00,0.00,80.00'
        },
        {
            id: 'quick-oval',
            name: 'Quick Oval',
            description: 'Short flat oval for testing',
            trackParam: '-50,1,0|50,1,0|50,1,70|-50,1,70|-50,1,0'
        },
        {
            id: 'flat-square',
            name: 'Flat Square',
            description: 'Simple square loop, low elevation',
            trackParam: '0,0,0|90,0,0|90,0,90|0,0,90|0,0,0'
        },
        {
            id: 'hill-climb',
            name: 'Hill Climb',
            description: 'Steep climbs and drops',
            trackParam:
                '0,2,0|40,8,20|80,18,10|100,25,-20|60,12,-50|20,6,-60|-30,14,-40|-50,22,-10|-20,10,20|0,2,0'
        },
        {
            id: 'figure-eight',
            name: 'Figure Eight',
            description: 'Crossing layout with banking',
            trackParam:
                '-60,2,0|0,4,40|60,2,0|0,6,-40|-60,2,0|0,4,40,15|60,2,0,15|0,6,-40,15|-60,2,0'
        }
    ],

    getPresetTracks: function() {
        return this.presetTracks.slice();
    },

    getPresetById: function(id) {
        for (var i = 0; i < this.presetTracks.length; i++) {
            if (this.presetTracks[i].id === id) return this.presetTracks[i];
        }
        return null;
    },

    saveToPersonalSlot: function(slotNumber, name, trackParam) {
        if (slotNumber < 1 || slotNumber > this.MAX_PERSONAL_SLOTS) return false;
        if (!trackParam || typeof trackParam !== 'string') return false;
        var key = this.STORAGE_KEY_PREFIX + slotNumber;
        var payload = {
            name: name || ('Track ' + slotNumber),
            trackParam: trackParam,
            savedAt: new Date().toISOString()
        };
        try {
            localStorage.setItem(key, JSON.stringify(payload));
            return true;
        } catch (e) {
            console.error('Failed to save track slot:', e);
            return false;
        }
    },

    loadFromPersonalSlot: function(slotNumber) {
        var key = this.STORAGE_KEY_PREFIX + slotNumber;
        var raw = localStorage.getItem(key);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            console.warn('Corrupted track slot', slotNumber, e);
            return null;
        }
    },

    deletePersonalSlot: function(slotNumber) {
        localStorage.removeItem(this.STORAGE_KEY_PREFIX + slotNumber);
    },

    getPersonalTracks: function() {
        var list = [];
        for (var slot = 1; slot <= this.MAX_PERSONAL_SLOTS; slot++) {
            var data = this.loadFromPersonalSlot(slot);
            if (data && data.trackParam) {
                list.push({
                    slot: slot,
                    name: data.name,
                    trackParam: data.trackParam,
                    savedAt: data.savedAt,
                    empty: false
                });
            } else {
                list.push({ slot: slot, name: null, empty: true });
            }
        }
        return list;
    }
};
