import Template from "./Template";
import { base64ToUint8, numberToEncoded, colorpalette } from "./utils";

/** Manages the template system.
 * This class handles all external requests for template modification, creation, and analysis.
 * It serves as the central coordinator between template instances and the user interface.
 * @class TemplateManager
 * @since 0.55.8
 * @example
 * // JSON structure for a template
 * {
 *   "whoami": "BlueMarble",
 *   "scriptVersion": "1.13.0",
 *   "schemaVersion": "2.1.0",
 *   "templates": {
 *     "0 $Z": {
 *       "name": "My Template",
 *       "enabled": true,
 *       "tiles": {
 *         "1231,0047,183,593": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "1231,0048,183,000": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     },
 *     "1 $Z": {
 *       "name": "My Template",
 *       "URL": "https://github.com/SwingTheVine/Wplace-BlueMarble/blob/main/dist/assets/Favicon.png",
 *       "URLType": "template",
 *       "enabled": false,
 *       "tiles": {
 *         "375,1846,276,188": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "376,1846,000,188": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     }
 *   }
 * }
 */

const RGB_TO_ID = new Map((colorpalette || []).filter((c) => Array.isArray(c?.rgb)).map((c) => [`${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}`, c.id]));

// === Helpers board snapshot + getter ===
function snapshotBoard(canvasSelector) {
    const cvs = document.querySelector(canvasSelector);
    if (!cvs) return null;
    const w = cvs.width,
        h = cvs.height;
    const ctx = cvs.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, w, h).data;

    // Map RGB -> id (site palette)
    const rgbToId = new Map((colorpalette || []).filter((c) => Array.isArray(c?.rgb)).map((c) => [`${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}`, c.id]));

    const buf = new Uint16Array(w * h);
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
        const r = img[i],
            g = img[i + 1],
            b = img[i + 2],
            a = img[i + 3];
        if (a === 0) {
            buf[p] = 65535;
            continue;
        } // transparent inconnu
        const id = rgbToId.get(`${r},${g},${b}`);
        buf[p] = id ?? 65534; // hors palette
    }
    return { width: w, height: h, colorIdxBuffer: buf };
}

function makeBoardGetter(boardWidth, colorIdxBuffer) {
    return (x, y) => {
        if (x < 0 || y < 0) return -1;
        const idx = y * boardWidth + x;
        return colorIdxBuffer[idx] ?? -1;
    };
}

export default class TemplateManager {
    /** The constructor for the {@link TemplateManager} class.
     * @since 0.55.8
     */
    constructor(name, version, overlay) {
        // Meta
        this.name = name; // Name of userscript
        this.version = version; // Version of userscript
        this.overlay = overlay; // The main instance of the Overlay class
        this.templatesVersion = "1.0.0"; // Version of JSON schema
        this.userID = null; // The ID of the current user
        this.encodingBase = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"; // Characters to use for encoding/decoding
        this.tileSize = 1000; // The number of pixels in a tile. Assumes the tile is square
        this.drawMult = 3; // The enlarged size for each pixel. E.g. when "3", a 1x1 pixel becomes a 1x1 pixel inside a 3x3 area. MUST BE ODD

        // Template
        this.canvasTemplate = null; // Our canvas
        this.canvasTemplateZoomed = null; // The template when zoomed out
        this.canvasTemplateID = "bm-canvas"; // Our canvas ID
        this.canvasMainID = "div#map canvas.maplibregl-canvas"; // The selector for the main canvas
        this.template = null; // The template image.
        this.templateState = ""; // The state of the template ('blob', 'proccessing', 'template', etc.)
        this.templatesArray = []; // All Template instnaces currently loaded (Template)
        this.templatesJSON = null; // All templates currently loaded (JSON)
        this.templatesShouldBeDrawn = true; // Should ALL templates be drawn to the canvas?
        this.tileProgress = new Map(); // Tracks per-tile progress stats {painted, required, wrong}
        this.tileColorIdxByTile = new Map(); // "xxxx,yyyy" -> { buf: Uint16Array(1e6), width:1000, height:1000 }
    }

    /** Retrieves the pixel art canvas.
     * If the canvas has been updated/replaced, it retrieves the new one.
     * @param {string} selector - The CSS selector to use to find the canvas.
     * @returns {HTMLCanvasElement|null} The canvas as an HTML Canvas Element, or null if the canvas does not exist
     * @since 0.58.3
     * @deprecated Not in use since 0.63.25
     */
    /* @__PURE__ */ getCanvas() {
        // If the stored canvas is "fresh", return the stored canvas
        if (document.body.contains(this.canvasTemplate)) {
            return this.canvasTemplate;
        }
        // Else, the stored canvas is "stale", get the canvas again

        // Attempt to find and destroy the "stale" canvas
        document.getElementById(this.canvasTemplateID)?.remove();

        const canvasMain = document.querySelector(this.canvasMainID);

        const canvasTemplateNew = document.createElement("canvas");
        canvasTemplateNew.id = this.canvasTemplateID;
        canvasTemplateNew.className = "maplibregl-canvas";
        canvasTemplateNew.style.position = "absolute";
        canvasTemplateNew.style.top = "0";
        canvasTemplateNew.style.left = "0";
        canvasTemplateNew.style.height = `${canvasMain?.clientHeight * (window.devicePixelRatio || 1)}px`;
        canvasTemplateNew.style.width = `${canvasMain?.clientWidth * (window.devicePixelRatio || 1)}px`;
        canvasTemplateNew.height = canvasMain?.clientHeight * (window.devicePixelRatio || 1);
        canvasTemplateNew.width = canvasMain?.clientWidth * (window.devicePixelRatio || 1);
        canvasTemplateNew.style.zIndex = "8999";
        canvasTemplateNew.style.pointerEvents = "none";
        canvasMain?.parentElement?.appendChild(canvasTemplateNew); // Append the newCanvas as a child of the parent of the main canvas
        this.canvasTemplate = canvasTemplateNew; // Store the new canvas

        window.addEventListener("move", this.onMove);
        window.addEventListener("zoom", this.onZoom);
        window.addEventListener("resize", this.onResize);

        return this.canvasTemplate; // Return the new canvas
    }

    /** Creates the JSON object to store templates in
     * @returns {{ whoami: string, scriptVersion: string, schemaVersion: string, templates: Object }} The JSON object
     * @since 0.65.4
     */
    async createJSON() {
        return {
            whoami: this.name.replace(" ", ""), // Name of userscript without spaces
            scriptVersion: this.version, // Version of userscript
            schemaVersion: this.templatesVersion, // Version of JSON schema
            templates: {}, // The templates
        };
    }

    /** Creates the template from the inputed file blob
     * @param {File} blob - The file blob to create a template from
     * @param {string} name - The display name of the template
     * @param {Array<number, number, number, number>} coords - The coordinates of the top left corner of the template
     * @since 0.65.77
     */
    async createTemplate(blob, name, coords) {
        // Creates the JSON object if it does not already exist
        if (!this.templatesJSON) {
            this.templatesJSON = await this.createJSON();
            console.log(`Creating JSON...`);
        }

        this.overlay.handleDisplayStatus(`Creating template at ${coords.join(", ")}...`);

        // Creates a new template instance
        const template = new Template({
            displayName: name,
            sortID: 0, // Object.keys(this.templatesJSON.templates).length || 0, // Uncomment this to enable multiple templates (1/2)
            authorID: numberToEncoded(this.userID || 0, this.encodingBase),
            file: blob,
            coords: coords,
        });
        //template.chunked = await template.createTemplateTiles(this.tileSize); // Chunks the tiles
        const { templateTiles, templateTilesBuffers } = await template.createTemplateTiles(this.tileSize); // Chunks the tiles
        template.chunked = templateTiles; // Stores the chunked tile bitmaps

        // Appends a child into the templates object
        // The child's name is the number of templates already in the list (sort order) plus the encoded player ID
        const storageKey = `${template.sortID} ${template.authorID}`;
        template.storageKey = storageKey;
        this.templatesJSON.templates[storageKey] = {
            name: template.displayName, // Display name of template
            coords: coords.join(", "), // The coords of the template
            enabled: true,
            tiles: templateTilesBuffers, // Stores the chunked tile buffers
            palette: template.colorPalette, // Persist palette and enabled flags
        };

        this.templatesArray = []; // Remove this to enable multiple templates (2/2)
        this.templatesArray.push(template); // Pushes the Template object instance to the Template Array

        // ==================== PIXEL COUNT DISPLAY SYSTEM ====================
        // Display pixel count statistics with internationalized number formatting
        // This provides immediate feedback to users about template complexity and size
        const pixelCountFormatted = new Intl.NumberFormat().format(template.pixelCount);
        this.overlay.handleDisplayStatus(`Template created at ${coords.join(", ")}! Total pixels: ${pixelCountFormatted}`);

        // Ensure color filter UI is visible when a template is created
        try {
            const colorUI = document.querySelector("#bm-contain-colorfilter");
            if (colorUI) {
                colorUI.style.display = "";
            }
            // Deferred palette list rendering; actual DOM is built in main via helper
            window.postMessage({ source: "blue-marble", bmEvent: "bm-rebuild-color-list" }, "*");
        } catch (_) {
            /* no-op */
        }

        console.log(Object.keys(this.templatesJSON.templates).length);
        console.log(this.templatesJSON);
        console.log(this.templatesArray);
        console.log(JSON.stringify(this.templatesJSON));

        // Mettre les compteurs en "restants" immédiatement
        try {
            this.refreshPaletteCounts(template);
        } catch (_) {}

        await this.#storeTemplates();
    }

    /** Generates a {@link Template} class instance from the JSON object template
     */
    #loadTemplate() {}

    /** Stores the JSON object of the loaded templates into TamperMonkey (GreaseMonkey) storage.
     * @since 0.72.7
     */
    async #storeTemplates() {
        GM.setValue("bmTemplates", JSON.stringify(this.templatesJSON));
    }

    /** Deletes a template from the JSON object.
     * Also delete's the corrosponding {@link Template} class instance
     */
    deleteTemplate() {}

    /** Disables the template from view
     */
    async disableTemplate() {
        // Creates the JSON object if it does not already exist
        if (!this.templatesJSON) {
            this.templatesJSON = await this.createJSON();
            console.log(`Creating JSON...`);
        }
    }

    /**
     * Retourne un getter (x,y)->colorId basé sur les buffers de tuiles reçues.
     * Si une tuile n'est pas encore en cache, renvoie -1.
     */
    makeBoardGetterFromTiles() {
        return (x, y) => {
            if (x < 0 || y < 0) return -1;
            const tx = Math.floor(x / this.tileSize);
            const ty = Math.floor(y / this.tileSize);
            const key = `${tx.toString().padStart(4, "0")},${ty.toString().padStart(4, "0")}`;
            const rec = this.tileColorIdxByTile.get(key);
            if (!rec) return -1;
            const lx = x % this.tileSize,
                ly = y % this.tileSize;
            return rec.buf[ly * this.tileSize + lx] ?? -1;
        };
    }

    /**
     * Recalcule les pixels RESTANTS par couleur pour `template`,
     * remplace `template.colorPalette[rgb].count` par ce restant,
     * puis redemande le rebuild de la liste couleurs.
     * Nécessite que `template.computeRemainingByColor` existe (dans Template.js) et que `template.pixels` soit indexé.
     */
    refreshPaletteCounts(template) {
        if (!template || typeof template.computeRemainingByColor !== "function") return;

        console.log("[BM] refreshPaletteCounts: start");

        const boardAt = this.makeBoardGetterFromTiles();
        console.log("[BM] tiles cached:", this.tileColorIdxByTile.size);

        if (!template?.pixels?.length) {
            console.warn("[BM] template.pixels est vide → patch Template.js manquant ?");
        }

        const remaining = template.computeRemainingByColor(boardAt);
        const sumRemaining = remaining.reduce((a, b) => a + b, 0);
        console.log("[BM] remaining per color (sum):", sumRemaining);

        // Comparatif de cohérence
        console.log("[BM] requiredPixelCount:", template.requiredPixelCount, "pixelCount:", template.pixelCount);

        // Log 1 couleur témoin (#19 par ex. si existe)
        const sampleId = 19;
        console.log("[BM] sample colorId", sampleId, "remaining:", remaining[sampleId] || 0);

        // 3) Construire un reverse-map id -> rgbKey depuis template.rgbToMeta
        const idToRgb = new Map();
        try {
            for (const [rgbKey, meta] of template.rgbToMeta.entries()) {
                if (meta && Number.isInteger(meta.id)) idToRgb.set(meta.id, rgbKey);
            }
        } catch (_) {}

        // 4) Écraser les counts du palette par les RESTANTS
        for (const [id, rgbKey] of idToRgb.entries()) {
            if (!rgbKey) continue;
            const remainingCount = remaining[id] || 0;
            if (!template.colorPalette[rgbKey]) {
                template.colorPalette[rgbKey] = { count: remainingCount, enabled: true };
            } else {
                template.colorPalette[rgbKey].count = remainingCount;
            }
        }

        // 5) Demander à l’UI de reconstruire la liste couleurs
        try {
            window.postMessage({ source: "blue-marble", bmEvent: "bm-rebuild-color-list" }, "*");
        } catch (_) {}
    }

    /** Draws all templates on the specified tile.
     * This method handles the rendering of template overlays on individual tiles.
     * @param {File} tileBlob - The pixels that are placed on a tile
     * @param {Array<number>} tileCoords - The tile coordinates [x, y]
     * @since 0.65.77
     */
    async drawTemplateOnTile(tileBlob, tileCoords) {
        // 1) early exit
        if (!this.templatesShouldBeDrawn) return tileBlob;

        const drawSize = this.tileSize * this.drawMult; // 1000*3

        // 2) normaliser la clé tuile et créer le bitmap
        tileCoords = `${tileCoords[0].toString().padStart(4, "0")},${tileCoords[1].toString().padStart(4, "0")}`;
        const tileBitmap = await createImageBitmap(tileBlob);

        // 3) Construire le buffer couleur (1000x1000) à partir du PNG reçu
        try {
            const bmTileOffCvs = new OffscreenCanvas(drawSize, drawSize);
            const bmTileOffCtx = bmTileOffCvs.getContext("2d", { willReadFrequently: true });
            bmTileOffCtx.imageSmoothingEnabled = false;
            bmTileOffCtx.clearRect(0, 0, drawSize, drawSize);
            bmTileOffCtx.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

            const bmTileRGBA = bmTileOffCtx.getImageData(0, 0, drawSize, drawSize).data;
            const bmColorBuf = new Uint16Array(this.tileSize * this.tileSize); // 1000*1000

            // échantillonner le pixel central de chaque bloc 3x3
            for (let gy = 1; gy < drawSize; gy += this.drawMult) {
                const ySmall = (gy - 1) / this.drawMult; // 0..999
                for (let gx = 1; gx < drawSize; gx += this.drawMult) {
                    const xSmall = (gx - 1) / this.drawMult; // 0..999
                    const idx = (gy * drawSize + gx) * 4;
                    const r = bmTileRGBA[idx],
                        g = bmTileRGBA[idx + 1],
                        b = bmTileRGBA[idx + 2],
                        a = bmTileRGBA[idx + 3];
                    let id = 65535; // transparent/inconnu
                    if (a >= 64) id = RGB_TO_ID.get(`${r},${g},${b}`) ?? 65534; // hors palette
                    bmColorBuf[ySmall * this.tileSize + xSmall] = id;
                }
            }

            this.tileColorIdxByTile.set(tileCoords, { buf: bmColorBuf, width: this.tileSize, height: this.tileSize });
        } catch (e) {
            console.warn("[BM] build tile color buffer failed:", e);
        }

        // 4) Recherche des templates concernés par cette tuile
        console.log(`Searching for templates in tile: "${tileCoords}"`);
        const templateArray = this.templatesArray.slice().sort((a, b) => a.sortID - b.sortID);

        const anyTouches = templateArray.some((t) => {
            if (!t?.chunked) return false;
            if (t.tilePrefixes && t.tilePrefixes.size > 0) return t.tilePrefixes.has(tileCoords);
            return Object.keys(t.chunked).some((k) => k.startsWith(tileCoords));
        });
        if (!anyTouches) return tileBlob;

        const templatesToDraw = templateArray
            .map((template) => {
                const matching = Object.keys(template.chunked).filter((k) => k.startsWith(tileCoords));
                if (matching.length === 0) return null;
                const coords = matching[0].split(","); // "xxxx,yyyy,px,py"
                return { bitmap: template.chunked[matching[0]], tileCoords: [coords[0], coords[1]], pixelCoords: [coords[2], coords[3]] };
            })
            .filter(Boolean);

        const templateCount = templatesToDraw.length || 0;

        // 5) Préparer le canvas de rendu
        let paintedCount = 0,
            wrongCount = 0,
            requiredCount = 0;

        const canvas = new OffscreenCanvas(drawSize, drawSize);
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = false;
        context.beginPath();
        context.rect(0, 0, drawSize, drawSize);
        context.clip();
        context.clearRect(0, 0, drawSize, drawSize);
        context.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

        // snapshot des pixels avant overlay
        let tilePixels = null;
        try {
            tilePixels = context.getImageData(0, 0, drawSize, drawSize).data;
        } catch (_) {}

        // 6) Dessin + stats
        for (const t of templatesToDraw) {
            // stats
            if (tilePixels) {
                try {
                    const w = t.bitmap.width,
                        h = t.bitmap.height;
                    const tmp = new OffscreenCanvas(w, h);
                    const tctx = tmp.getContext("2d", { willReadFrequently: true });
                    tctx.imageSmoothingEnabled = false;
                    tctx.clearRect(0, 0, w, h);
                    tctx.drawImage(t.bitmap, 0, 0);
                    const td = tctx.getImageData(0, 0, w, h).data;

                    const ox = Number(t.pixelCoords[0]) * this.drawMult;
                    const oy = Number(t.pixelCoords[1]) * this.drawMult;

                    for (let y = 0; y < h; y++)
                        for (let x = 0; x < w; x++) {
                            if (x % this.drawMult !== 1 || y % this.drawMult !== 1) continue;
                            const gx = x + ox,
                                gy = y + oy;
                            if (gx < 0 || gy < 0 || gx >= drawSize || gy >= drawSize) continue;
                            const ti = (y * w + x) * 4;
                            const tr = td[ti],
                                tg = td[ti + 1],
                                tb = td[ti + 2],
                                ta = td[ti + 3];

                            if (ta < 64) {
                                try {
                                    const active = this.templatesArray?.[0];
                                    const pi = (gy * drawSize + gx) * 4;
                                    const pr = tilePixels[pi],
                                        pg = tilePixels[pi + 1],
                                        pb = tilePixels[pi + 2],
                                        pa = tilePixels[pi + 3];
                                    const key = `${pr},${pg},${pb}`;
                                    const isSite = active?.allowedColorsSet ? active.allowedColorsSet.has(key) : false;
                                    if (pa >= 64 && isSite) wrongCount++;
                                } catch (_) {}
                                continue;
                            }
                            try {
                                const active = this.templatesArray?.[0];
                                if (active?.allowedColorsSet && !active.allowedColorsSet.has(`${tr},${tg},${tb}`)) continue;
                            } catch (_) {}

                            requiredCount++;
                            const pi = (gy * drawSize + gx) * 4;
                            const pr = tilePixels[pi],
                                pg = tilePixels[pi + 1],
                                pb = tilePixels[pi + 2],
                                pa = tilePixels[pi + 3];
                            if (pa < 64) {
                                /* unpainted */
                            } else if (pr === tr && pg === tg && pb === tb) paintedCount++;
                            else wrongCount++;
                        }
                } catch (e) {
                    console.warn("Failed to compute per-tile painted/wrong stats:", e);
                }
            }

            // overlay (avec filtre palette)
            try {
                const active = this.templatesArray?.[0];
                const palette = active?.colorPalette || {};
                const hasDisabled = Object.values(palette).some((v) => v?.enabled === false);
                if (!hasDisabled) {
                    context.drawImage(t.bitmap, Number(t.pixelCoords[0]) * this.drawMult, Number(t.pixelCoords[1]) * this.drawMult);
                } else {
                    const w = t.bitmap.width,
                        h = t.bitmap.height;
                    const fc = new OffscreenCanvas(w, h);
                    const fctx = fc.getContext("2d", { willReadFrequently: true });
                    fctx.imageSmoothingEnabled = false;
                    fctx.clearRect(0, 0, w, h);
                    fctx.drawImage(t.bitmap, 0, 0);
                    const im = fctx.getImageData(0, 0, w, h);
                    const dt = im.data;
                    for (let y = 0; y < h; y++)
                        for (let x = 0; x < w; x++) {
                            if (x % this.drawMult !== 1 || y % this.drawMult !== 1) continue;
                            const i = (y * w + x) * 4;
                            const r = dt[i],
                                g = dt[i + 1],
                                b = dt[i + 2],
                                a = dt[i + 3];
                            if (a < 1) continue;
                            const key = `${r},${g},${b}`;
                            const inSite = active?.allowedColorsSet ? active.allowedColorsSet.has(key) : true;
                            const enabled = palette?.[key]?.enabled !== false;
                            if (!inSite || !enabled) dt[i + 3] = 0;
                        }
                    fctx.putImageData(im, 0, 0);
                    context.drawImage(fc, Number(t.pixelCoords[0]) * this.drawMult, Number(t.pixelCoords[1]) * this.drawMult);
                }
            } catch (_) {
                context.drawImage(t.bitmap, Number(t.pixelCoords[0]) * this.drawMult, Number(t.pixelCoords[1]) * this.drawMult);
            }
        }

        // 7) Statut + refresh palette (restants)
        if (templateCount > 0) {
            const tileKey = tileCoords;
            this.tileProgress.set(tileKey, { painted: paintedCount, required: requiredCount, wrong: wrongCount });

            let aggPainted = 0,
                aggRequiredTiles = 0;
            for (const s of this.tileProgress.values()) {
                aggPainted += s.painted || 0;
                aggRequiredTiles += s.required || 0;
            }
            const totalRequiredTemplates = this.templatesArray.reduce((sum, t) => sum + (t.requiredPixelCount || t.pixelCount || 0), 0);
            const totalRequired = totalRequiredTemplates > 0 ? totalRequiredTemplates : aggRequiredTiles;

            const paintedStr = new Intl.NumberFormat().format(aggPainted);
            const requiredStr = new Intl.NumberFormat().format(totalRequired);
            const wrongStr = new Intl.NumberFormat().format(totalRequired - aggPainted);

            this.overlay.handleDisplayStatus(
                `Displaying ${templateCount} template${templateCount === 1 ? "" : "s"}.\nPainted ${paintedStr} / ${requiredStr} • Wrong ${wrongStr}`
            );
        } else {
            this.overlay.handleDisplayStatus(`Displaying ${templateCount} templates.`);
        }

        try {
            const activeTemplate = this.templatesArray?.[0];
            if (activeTemplate) this.refreshPaletteCounts(activeTemplate);
        } catch (_) {}

        // 8) retourner la tuile avec overlay
        return await canvas.convertToBlob({ type: "image/png" });
    }

    /** Imports the JSON object, and appends it to any JSON object already loaded
     * @param {string} json - The JSON string to parse
     */
    importJSON(json) {
        console.log(`Importing JSON...`);
        console.log(json);

        // If the passed in JSON is a Blue Marble template object...
        if (json?.whoami == "BlueMarble") {
            this.#parseBlueMarble(json); // ...parse the template object as Blue Marble
        }
    }

    /** Parses the Blue Marble JSON object
     * @param {string} json - The JSON string to parse
     * @since 0.72.13
     */
    async #parseBlueMarble(json) {
        console.log(`Parsing BlueMarble...`);

        const templates = json.templates;

        console.log(`BlueMarble length: ${Object.keys(templates).length}`);

        if (Object.keys(templates).length > 0) {
            for (const template in templates) {
                const templateKey = template;
                const templateValue = templates[template];
                console.log(templateKey);

                if (templates.hasOwnProperty(template)) {
                    const templateKeyArray = templateKey.split(" "); // E.g., "0 $Z" -> ["0", "$Z"]
                    const sortID = Number(templateKeyArray?.[0]); // Sort ID of the template
                    const authorID = templateKeyArray?.[1] || "0"; // User ID of the person who exported the template
                    const displayName = templateValue.name || `Template ${sortID || ""}`; // Display name of the template
                    //const coords = templateValue?.coords?.split(',').map(Number); // "1,2,3,4" -> [1, 2, 3, 4]
                    const tilesbase64 = templateValue.tiles;
                    const templateTiles = {}; // Stores the template bitmap tiles for each tile.
                    let requiredPixelCount = 0; // Global required pixel count for this imported template
                    const paletteMap = new Map(); // Accumulates color counts across tiles (center pixels only)

                    for (const tile in tilesbase64) {
                        console.log(tile);
                        if (tilesbase64.hasOwnProperty(tile)) {
                            const encodedTemplateBase64 = tilesbase64[tile];
                            const templateUint8Array = base64ToUint8(encodedTemplateBase64); // Base 64 -> Uint8Array

                            const templateBlob = new Blob([templateUint8Array], { type: "image/png" }); // Uint8Array -> Blob
                            const templateBitmap = await createImageBitmap(templateBlob); // Blob -> Bitmap
                            templateTiles[tile] = templateBitmap;

                            // Count required pixels in this bitmap (center pixels with alpha >= 64 and not #deface)
                            try {
                                const w = templateBitmap.width;
                                const h = templateBitmap.height;
                                const c = new OffscreenCanvas(w, h);
                                const cx = c.getContext("2d", { willReadFrequently: true });
                                cx.imageSmoothingEnabled = false;
                                cx.clearRect(0, 0, w, h);
                                cx.drawImage(templateBitmap, 0, 0);
                                const data = cx.getImageData(0, 0, w, h).data;
                                for (let y = 0; y < h; y++) {
                                    for (let x = 0; x < w; x++) {
                                        // Only count center pixels of 3x blocks
                                        if (x % this.drawMult !== 1 || y % this.drawMult !== 1) {
                                            continue;
                                        }
                                        const idx = (y * w + x) * 4;
                                        const r = data[idx];
                                        const g = data[idx + 1];
                                        const b = data[idx + 2];
                                        const a = data[idx + 3];
                                        if (a < 64) {
                                            continue;
                                        }
                                        if (r === 222 && g === 250 && b === 206) {
                                            continue;
                                        }
                                        requiredPixelCount++;
                                        const key = `${r},${g},${b}`;
                                        paletteMap.set(key, (paletteMap.get(key) || 0) + 1);
                                    }
                                }
                            } catch (e) {
                                console.warn("Failed to count required pixels for imported tile", e);
                            }
                        }
                    }

                    // Creates a new Template class instance
                    const template = new Template({
                        displayName: displayName,
                        sortID: sortID || this.templatesArray?.length || 0,
                        authorID: authorID || "",
                        //coords: coords
                    });
                    template.chunked = templateTiles;
                    template.requiredPixelCount = requiredPixelCount;
                    // Construct colorPalette from paletteMap
                    const paletteObj = {};
                    for (const [key, count] of paletteMap.entries()) {
                        paletteObj[key] = { count, enabled: true };
                    }
                    template.colorPalette = paletteObj;
                    // Populate tilePrefixes for fast-scoping
                    try {
                        Object.keys(templateTiles).forEach((k) => {
                            template.tilePrefixes?.add(k.split(",").slice(0, 2).join(","));
                        });
                    } catch (_) {}
                    // Merge persisted palette (enabled/disabled) if present
                    try {
                        const persisted = templates?.[templateKey]?.palette;
                        if (persisted) {
                            for (const [rgb, meta] of Object.entries(persisted)) {
                                if (!template.colorPalette[rgb]) {
                                    template.colorPalette[rgb] = { count: meta?.count || 0, enabled: !!meta?.enabled };
                                } else {
                                    template.colorPalette[rgb].enabled = !!meta?.enabled;
                                }
                            }
                        }
                    } catch (_) {}
                    // Store storageKey for later writes
                    template.storageKey = templateKey;
                    this.templatesArray.push(template);
                    console.log(this.templatesArray);
                    console.log(`^^^ This ^^^`);
                }
            }
            // After importing templates from storage, reveal color UI and request palette list build
            try {
                const colorUI = document.querySelector("#bm-contain-colorfilter");
                if (colorUI) {
                    colorUI.style.display = "";
                }
                window.postMessage({ source: "blue-marble", bmEvent: "bm-rebuild-color-list" }, "*");
            } catch (_) {
                /* no-op */
            }
        }
    }

    /** Parses the OSU! Place JSON object
     */
    #parseOSU() {}

    /** Sets the `templatesShouldBeDrawn` boolean to a value.
     * @param {boolean} value - The value to set the boolean to
     * @since 0.73.7
     */
    setTemplatesShouldBeDrawn(value) {
        this.templatesShouldBeDrawn = value;
    }
}
