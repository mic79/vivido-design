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
            description: 'Default city circuit (VRrunner map)',
            trackParam:
                '316.26,50.00,991.64|356.25,51.00,991.64|388.26,55.00,943.64|412.26,55.00,919.64|' +
                '452.26,58.00,927.64|470.57,62.00,953.75,15|424.59,59.00,980.20,15|395.33,63.00,975.83,15|' +
                '386.14,62.00,917.81,5|364.92,60.00,872.39|380.26,65.00,839.64|419.85,66.00,838.71|' +
                '465.00,75.00,873.96|472.24,81.00,926.72|435.39,76.00,950.83|379.31,80.00,971.75|' +
                '332.26,83.00,967.64|300.26,83.00,919.64|292.26,77.00,879.64|316.26,73.00,839.64,20|' +
                '364.26,74.00,831.64,20|424.72,79.00,855.25,45|407.45,74.00,921.95,25|359.07,61.00,957.61,20|' +
                '324.26,49.00,911.64,5|308.26,50.00,871.64,-5|300.26,55.00,839.64,-10|276.26,58.00,831.64,-10|' +
                '252.26,56.00,855.64,-10|260.26,56.00,895.64,-5|252.26,51.00,935.64|281.98,46.00,984.37'
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
