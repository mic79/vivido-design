/**
 * VR menu + table selector (DriveVR2-style).
 * World-space panel above the playfield; B toggles menu; trigger clicks buttons.
 */

export function createPinballVrMenu(deps) {
    const {
        THREE,
        getRen,
        getScene,
        getVrRig,
        getTableScreenMenuAnchor,
        getMenuLookTarget,
        pulseVrHaptic,
        getVrCtrl0,
        getVrCtrl1,
        getTableManager,
        getTableSelectorTab,
        setTableSelectorTab,
        renderTableLists,
        updateTableCurrentLabel,
        getEditorMode,
        toggleEditorMode,
        loadPresetById,
        loadPersonalSlot,
        savePersonalSlot,
        overwritePersonalSlot,
        deletePersonalSlot,
    } = deps;

    let isMenuVisible = false;
    let isTableSelectorVisible = false;
    let vrMenu = null;
    let vrTableSelector = null;
    const vrMenuButtons = [];
    const vrTableButtons = [];
    let vrMenuRaycaster = null;
    const vrMenuTriggerWasPressed = { left: false, right: false };
    const vrMenuHoverId = { left: null, right: null };
    let vrPrevMenuB = false;
    let lastMenuToggleTime = 0;

    function ren() { return getRen(); }
    function vrRig() { return getVrRig(); }

    function setButtonHover(button, hovered) {
        if (!button?.userData?.material || button.userData.active || button.userData.disabled) return;
        const mat = button.userData.material;
        if (hovered) {
            mat.color.setHex(0xffffff);
            mat.opacity = 1;
            button.scale.set(1.06, 1.06, 1);
            button.userData.hovered = true;
        } else {
            mat.color.copy(button.userData.originalColor);
            mat.opacity = 0.85;
            button.scale.set(1, 1, 1);
            button.userData.hovered = false;
        }
    }

    function resetButtonHoverStates(buttons) {
        buttons.forEach(button => setButtonHover(button, false));
    }

    /** Upright panel facing the player (yaw only — no table-slope tilt or roll). */
    function orientMenuPanel(group, lookTarget) {
        if (!lookTarget) {
            group.rotation.set(0, 0, 0);
            return;
        }
        const dx = lookTarget.x - group.position.x;
        const dz = lookTarget.z - group.position.z;
        group.rotation.set(0, Math.atan2(dx, dz), 0);
    }

    function updateVrMenuPanelPosition(group) {
        if (!group?.visible) return;
        const anchor = getTableScreenMenuAnchor?.();
        if (!anchor) return;
        group.position.copy(anchor);
        orientMenuPanel(group, getMenuLookTarget?.());
    }

    function updateVrMenuPanelsPosition() {
        updateVrMenuPanelPosition(vrMenu);
        updateVrMenuPanelPosition(vrTableSelector);
    }

    function isVRPointerMenuActive() {
        if (!ren()?.xr?.isPresenting) return false;
        if (vrTableSelector?.visible) return true;
        return !!(isMenuVisible && vrMenu?.visible);
    }

    function createVRButton(text, x, y, width, height, color, id) {
        const group = new THREE.Group();
        group.position.set(x, y, 0);
        group.userData = { type: 'button', id, active: false };

        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color),
            transparent: true,
            opacity: 0.85,
        });
        group.add(new THREE.Mesh(new THREE.PlaneGeometry(width, height), material));

        const textCanvas = document.createElement('canvas');
        textCanvas.width = 256;
        textCanvas.height = 64;
        const ctx = textCanvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 22px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(text, 128, 40);
        const textTexture = new THREE.CanvasTexture(textCanvas);
        const textMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(width * 0.92, height * 0.72),
            new THREE.MeshBasicMaterial({ map: textTexture, transparent: true })
        );
        textMesh.position.z = 0.001;
        group.add(textMesh);

        group.userData.originalColor = new THREE.Color(color);
        group.userData.material = material;
        group.userData.textCanvas = textCanvas;
        group.userData.textTexture = textTexture;
        return group;
    }

    function createVRText(text, x, y, scale) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.font = '20px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(text, 128, 40);
        const texture = new THREE.CanvasTexture(canvas);
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(scale, scale * 0.25),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true })
        );
        mesh.position.set(x, y, 0);
        mesh.userData = { canvas, texture };
        return mesh;
    }

    function setVrButtonText(button, text) {
        const canvas = button?.userData?.textCanvas;
        const texture = button?.userData?.textTexture;
        if (!canvas || !texture) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 22px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(text, canvas.width / 2, 40);
        texture.needsUpdate = true;
    }

    function attachPanel(group) {
        const scene = getScene?.();
        if (!scene) return;
        if (group.parent !== scene) {
            if (group.parent) group.parent.remove(group);
            scene.add(group);
        }
    }

    function createVRMenu() {
        if (vrMenu) return;
        vrMenu = new THREE.Group();
        attachPanel(vrMenu);

        const border = new THREE.Mesh(
            new THREE.PlaneGeometry(0.72, 0.52),
            new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.85 })
        );
        border.position.z = -0.02;
        vrMenu.add(border);

        const bg = new THREE.Mesh(
            new THREE.PlaneGeometry(0.68, 0.48),
            new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.88 })
        );
        bg.position.z = -0.01;
        vrMenu.add(bg);

        vrMenu.add(createVRText('PINBALLVR2 MENU', 0, 0.18, 0.55));

        const tableLabel = createVRText('Current table', 0, 0.1, 0.48);
        tableLabel.userData.type = 'display';
        tableLabel.userData.id = 'table-name-display';
        vrMenu.add(tableLabel);

        const editorBtn = createVRButton('EDITOR: OFF', 0, 0, 0.38, 0.07, '#aa6600', 'editor-toggle');
        const tableBtn = createVRButton('SELECT TABLE', 0, -0.09, 0.38, 0.07, '#6644aa', 'select-table');
        const closeBtn = createVRButton('CLOSE', 0, -0.18, 0.28, 0.07, '#666666', 'close');
        vrMenu.add(editorBtn, tableBtn, closeBtn);
        vrMenuButtons.push(editorBtn, tableBtn, closeBtn);

        vrMenuRaycaster = new THREE.Raycaster();
        vrMenu.visible = false;
    }

    function createVRTableSelector() {
        if (vrTableSelector) return;
        vrTableSelector = new THREE.Group();
        attachPanel(vrTableSelector);

        const bg = new THREE.Mesh(
            new THREE.PlaneGeometry(0.78, 0.62),
            new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.92 })
        );
        bg.position.z = -0.01;
        vrTableSelector.add(bg);
        vrTableSelector.userData.bgMesh = bg;

        vrTableSelector.add(createVRText('SELECT TABLE', 0, 0.26, 0.55));

        const currentLabel = createVRText('Current', 0, 0.18, 0.44);
        currentLabel.userData.type = 'display';
        currentLabel.userData.id = 'table-current-vr';
        vrTableSelector.add(currentLabel);

        const tabPresets = createVRButton('PRESETS', -0.18, 0.1, 0.2, 0.055, '#0066ff', 'table-tab-presets');
        const tabPersonal = createVRButton('MY TABLES', 0.18, 0.1, 0.2, 0.055, '#666666', 'table-tab-personal');
        vrTableSelector.add(tabPresets, tabPersonal);
        vrTableButtons.push(tabPresets, tabPersonal);

        const listGroup = new THREE.Group();
        listGroup.position.set(0, -0.02, 0);
        listGroup.userData.type = 'table-list-group';
        vrTableSelector.add(listGroup);

        const backBtn = createVRButton('BACK', 0, -0.26, 0.2, 0.06, '#666666', 'table-selector-back');
        vrTableSelector.add(backBtn);
        vrTableButtons.push(backBtn);

        vrTableSelector.visible = false;
    }

    function clearVRTableListButtons() {
        if (!vrTableSelector) return;
        const listGroup = vrTableSelector.children.find(c => c.userData?.type === 'table-list-group');
        if (!listGroup) return;
        while (listGroup.children.length) {
            const child = listGroup.children[0];
            listGroup.remove(child);
            const idx = vrTableButtons.indexOf(child);
            if (idx >= 0) vrTableButtons.splice(idx, 1);
        }
    }

    function layoutVRTableSelectorPanel(rowCount) {
        if (!vrTableSelector) return;
        const headerH = 0.36;
        const rowH = 0.072;
        const footerH = 0.12;
        const panelH = Math.max(0.58, headerH + rowCount * rowH + footerH);
        const bg = vrTableSelector.userData.bgMesh;
        if (bg) {
            bg.geometry.dispose();
            bg.geometry = new THREE.PlaneGeometry(0.78, panelH);
        }
        const backBtn = vrTableButtons.find(b => b.userData.id === 'table-selector-back');
        if (backBtn) backBtn.position.y = -(panelH * 0.5 - 0.07);
    }

    function populateVRTableListButtons() {
        if (!vrTableSelector) return;
        const tm = getTableManager();
        if (!tm) return;
        clearVRTableListButtons();
        const listGroup = vrTableSelector.children.find(c => c.userData?.type === 'table-list-group');
        if (!listGroup) return;

        const tab = getTableSelectorTab();
        let row = 0;
        const startY = 0.08;
        const spacing = 0.075;

        if (tab === 'presets') {
            tm.getPresetTables().forEach(p => {
                const y = startY - row * spacing;
                listGroup.add(createVRText(p.name, -0.22, y, 0.34));
                const loadBtn = createVRButton('LOAD', 0.28, y, 0.14, 0.045, '#44aa44', 'table-load-preset-' + p.id);
                listGroup.add(loadBtn);
                vrTableButtons.push(loadBtn);
                row++;
            });
        } else {
            tm.getPersonalTables().forEach(slot => {
                const y = startY - row * spacing;
                if (slot.empty) {
                    listGroup.add(createVRText('Slot ' + slot.slot + ': Empty', -0.18, y, 0.3));
                    const saveBtn = createVRButton('SAVE', 0.28, y, 0.14, 0.045, '#4488ff', 'table-save-personal-' + slot.slot);
                    listGroup.add(saveBtn);
                    vrTableButtons.push(saveBtn);
                } else {
                    listGroup.add(createVRText(slot.slot + '. ' + slot.name, -0.24, y, 0.26));
                    const loadBtn = createVRButton('LOAD', 0.06, y, 0.1, 0.042, '#44aa44', 'table-load-personal-' + slot.slot);
                    const overBtn = createVRButton('OVR', 0.18, y, 0.09, 0.042, '#aa8844', 'table-over-personal-' + slot.slot);
                    const delBtn = createVRButton('DEL', 0.28, y, 0.08, 0.042, '#aa4444', 'table-del-personal-' + slot.slot);
                    listGroup.add(loadBtn, overBtn, delBtn);
                    vrTableButtons.push(loadBtn, overBtn, delBtn);
                }
                row++;
            });
        }
        layoutVRTableSelectorPanel(row);
    }

    function updateVRMenuDisplay() {
        if (!vrMenu) return;
        const editorBtn = vrMenuButtons.find(b => b.userData.id === 'editor-toggle');
        if (editorBtn) {
            const on = getEditorMode();
            editorBtn.userData.active = on;
            setVrButtonText(editorBtn, on ? 'EDITOR: ON' : 'EDITOR: OFF');
            if (editorBtn.userData.material) {
                editorBtn.userData.material.color.setHex(on ? 0x00aa44 : 0xaa6600);
                editorBtn.userData.originalColor.setHex(on ? 0x00aa44 : 0xaa6600);
            }
        }
        const label = vrMenu.children.find(c => c.userData?.id === 'table-name-display');
        if (label?.userData?.canvas) {
            const ctx = label.userData.canvas.getContext('2d');
            ctx.clearRect(0, 0, 256, 64);
            ctx.fillStyle = '#00ffaa';
            ctx.font = '18px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(getTableManager()?.currentTableName || 'Table', 128, 40);
            label.userData.texture.needsUpdate = true;
        }
    }

    function updateVRTableSelectorDisplay() {
        if (!vrTableSelector) return;
        populateVRTableListButtons();
        const tab = getTableSelectorTab();
        const tabPresets = vrTableButtons.find(b => b.userData.id === 'table-tab-presets');
        const tabPersonal = vrTableButtons.find(b => b.userData.id === 'table-tab-personal');
        if (tabPresets?.userData.material) {
            const on = tab === 'presets';
            tabPresets.userData.active = on;
            tabPresets.userData.material.color.setHex(on ? 0x0088ff : 0x666666);
            tabPresets.userData.originalColor.setHex(on ? 0x0088ff : 0x666666);
        }
        if (tabPersonal?.userData.material) {
            const on = tab === 'personal';
            tabPersonal.userData.active = on;
            tabPersonal.userData.material.color.setHex(on ? 0x0088ff : 0x666666);
            tabPersonal.userData.originalColor.setHex(on ? 0x0088ff : 0x666666);
        }
        const currentLabel = vrTableSelector.children.find(c => c.userData?.id === 'table-current-vr');
        if (currentLabel?.userData?.canvas) {
            const ctx = currentLabel.userData.canvas.getContext('2d');
            ctx.clearRect(0, 0, 256, 64);
            ctx.fillStyle = '#00ff88';
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(getTableManager()?.currentTableName || 'Table', 128, 40);
            currentLabel.userData.texture.needsUpdate = true;
        }
    }

    function getVrRayControllerForHand(hand) {
        const c0 = getVrCtrl0();
        const c1 = getVrCtrl1();
        if (c0?.userData?.xrInputSource?.handedness === hand) return c0;
        if (c1?.userData?.xrInputSource?.handedness === hand) return c1;
        const session = ren()?.xr?.getSession();
        if (session?.inputSources) {
            for (const src of session.inputSources) {
                if (src.handedness !== hand) continue;
                if (c0?.userData?.xrInputSource === src) return c0;
                if (c1?.userData?.xrInputSource === src) return c1;
            }
        }
        return hand === 'right' ? (c1 || c0) : (c0 || c1);
    }

    function vrMenuTriggerPressed(gp) {
        const b = gp?.buttons?.[0];
        return !!(b?.pressed || (b?.value != null && b.value > 0.55));
    }

    function vrMenuActiveButtons() {
        return vrTableSelector?.visible ? vrTableButtons : vrMenuButtons;
    }

    function vrMenuRaycastButton(controller) {
        if (!vrMenuRaycaster || !controller?.matrixWorld) return null;
        const activeButtons = vrMenuActiveButtons();
        if (!activeButtons.length) return null;
        const rot = new THREE.Matrix4().extractRotation(controller.matrixWorld);
        vrMenuRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
        vrMenuRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(rot);
        const hits = vrMenuRaycaster.intersectObjects(activeButtons, true);
        if (!hits.length) return null;
        let obj = hits[0].object;
        while (obj && !obj.userData?.id) obj = obj.parent;
        return obj?.userData?.id ? obj : hits[0].object.parent;
    }

    function activateVrMenuButton(clickedObject, hand) {
        if (!clickedObject?.userData?.id) return;
        if (clickedObject.userData.disabled) return;
        pulseVrHaptic?.(hand, 0.75, 55);
        const id = clickedObject.userData.id;

        if (id === 'editor-toggle') {
            toggleEditorMode();
        } else if (id === 'select-table') {
            openTableSelector();
        } else if (id === 'close') {
            if (vrTableSelector?.visible) closeTableSelector();
            else toggleMenu();
        } else if (id === 'table-selector-back') {
            closeTableSelector();
        } else if (id === 'table-tab-presets') {
            setTableSelectorTab('presets');
        } else if (id === 'table-tab-personal') {
            setTableSelectorTab('personal');
        } else if (id.startsWith('table-load-preset-')) {
            loadPresetById(id.replace('table-load-preset-', ''));
            closeTableSelector();
            closeMenuFully();
        } else if (id.startsWith('table-load-personal-')) {
            loadPersonalSlot(+id.replace('table-load-personal-', ''));
            closeTableSelector();
            closeMenuFully();
        } else if (id.startsWith('table-save-personal-')) {
            savePersonalSlot(+id.replace('table-save-personal-', ''));
        } else if (id.startsWith('table-over-personal-')) {
            overwritePersonalSlot(+id.replace('table-over-personal-', ''));
        } else if (id.startsWith('table-del-personal-')) {
            deletePersonalSlot(+id.replace('table-del-personal-', ''));
        }

        if (vrMenu?.visible) updateVRMenuDisplay();
        if (vrTableSelector?.visible) updateVRTableSelectorDisplay();
        renderTableLists?.();
        updateTableCurrentLabel?.();
    }

    function closeMenuFully() {
        isMenuVisible = false;
        isTableSelectorVisible = false;
        if (vrMenu) vrMenu.visible = false;
        if (vrTableSelector) vrTableSelector.visible = false;
        vrMenuHoverId.left = null;
        vrMenuHoverId.right = null;
        document.getElementById('tableSelector')?.classList.remove('open');
    }

    function updateVRMenuPointers() {
        if (!isVRPointerMenuActive() || !vrMenuRaycaster) {
            vrMenuTriggerWasPressed.left = false;
            vrMenuTriggerWasPressed.right = false;
            vrMenuHoverId.left = null;
            vrMenuHoverId.right = null;
            return;
        }
        updateVrMenuPanelsPosition();
        const session = ren()?.xr?.getSession();
        if (!session?.inputSources) return;
        const activeButtons = vrMenuActiveButtons();

        resetButtonHoverStates(activeButtons);

        const seen = { left: false, right: false };
        for (let i = 0; i < session.inputSources.length; i++) {
            const src = session.inputSources[i];
            const hand = src.handedness;
            if (hand !== 'left' && hand !== 'right' || !src.gamepad) continue;
            seen[hand] = true;

            const controller = getVrRayControllerForHand(hand);
            const hit = vrMenuRaycastButton(controller);
            const hitId = hit?.userData?.id || null;

            if (hit) setButtonHover(hit, true);

            if (hitId !== vrMenuHoverId[hand]) {
                if (hitId) pulseVrHaptic?.(hand, 0.35, 28);
                vrMenuHoverId[hand] = hitId;
            }

            const pressed = vrMenuTriggerPressed(src.gamepad);
            if (pressed && !vrMenuTriggerWasPressed[hand] && hit) {
                activateVrMenuButton(hit, hand);
            }
            vrMenuTriggerWasPressed[hand] = pressed;
        }
        if (!seen.left) {
            vrMenuTriggerWasPressed.left = false;
            vrMenuHoverId.left = null;
        }
        if (!seen.right) {
            vrMenuTriggerWasPressed.right = false;
            vrMenuHoverId.right = null;
        }
    }

    function processVrMenuToggleButton() {
        if (!ren()?.xr?.isPresenting) {
            vrPrevMenuB = false;
            return;
        }
        const session = ren().xr.getSession();
        if (!session?.inputSources) return;
        let bNow = false;
        for (const src of session.inputSources) {
            if (src.gamepad?.buttons?.[5]?.pressed) {
                bNow = true;
                break;
            }
        }
        const now = performance.now();
        if (bNow && !vrPrevMenuB && now - lastMenuToggleTime > 450) {
            toggleMenu();
            lastMenuToggleTime = now;
        }
        vrPrevMenuB = bNow;
    }

    function toggleMenu() {
        if (ren()?.xr?.isPresenting && isMenuVisible && isTableSelectorVisible) {
            closeTableSelector();
            return;
        }
        if (isMenuVisible && isTableSelectorVisible) {
            closeTableSelector();
        }
        isMenuVisible = !isMenuVisible;
        if (!isMenuVisible) closeMenuFully();
        else {
            createVRMenu();
            if (vrMenu) {
                vrMenu.visible = true;
                if (vrTableSelector) vrTableSelector.visible = false;
                updateVrMenuPanelsPosition();
                updateVRMenuDisplay();
            }
        }
        if (!ren()?.xr?.isPresenting) {
            document.getElementById('gameMenu')?.classList.toggle('open', isMenuVisible);
        }
    }

    function openTableSelector() {
        isTableSelectorVisible = true;
        renderTableLists?.();
        updateTableCurrentLabel?.();

        if (ren()?.xr?.isPresenting) {
            if (!isMenuVisible) {
                isMenuVisible = true;
                createVRMenu();
            }
            createVRTableSelector();
            if (vrMenu) vrMenu.visible = false;
            if (vrTableSelector) {
                vrTableSelector.visible = true;
                updateVrMenuPanelsPosition();
                updateVRTableSelectorDisplay();
            }
        } else {
            document.getElementById('tableSelector')?.classList.add('open');
            document.getElementById('gameMenu')?.classList.remove('open');
        }
    }

    function closeTableSelector() {
        isTableSelectorVisible = false;
        document.getElementById('tableSelector')?.classList.remove('open');
        if (ren()?.xr?.isPresenting) {
            if (vrTableSelector) vrTableSelector.visible = false;
            if (vrMenu && isMenuVisible) {
                vrMenu.visible = true;
                updateVRMenuDisplay();
            }
        } else if (isMenuVisible) {
            document.getElementById('gameMenu')?.classList.add('open');
        }
    }

    function destroyVrPanels() {
        if (vrMenu?.parent) vrMenu.parent.remove(vrMenu);
        if (vrTableSelector?.parent) vrTableSelector.parent.remove(vrTableSelector);
        vrMenu = null;
        vrTableSelector = null;
        vrMenuButtons.length = 0;
        vrTableButtons.length = 0;
        vrMenuRaycaster = null;
    }

    function onExitXR() {
        closeMenuFully();
        destroyVrPanels();
        vrPrevMenuB = false;
    }

    return {
        isMenuVisible: () => isMenuVisible,
        isTableSelectorVisible: () => isTableSelectorVisible,
        isVRPointerMenuActive,
        toggleMenu,
        openTableSelector,
        closeTableSelector,
        closeMenuFully,
        updateVRMenuPointers,
        processVrMenuToggleButton,
        updateVRMenuDisplay,
        updateVRTableSelectorDisplay,
        onExitXR,
    };
}
