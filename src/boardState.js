// boardState.js
import { colorpalette } from "./utils.js";

// Map RGB -> id
const rgbToId = new Map((colorpalette || []).filter((c) => Array.isArray(c?.rgb)).map((c) => [`${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}`, c.id]));

/**
 * Prend un snapshot du canvas du board et renvoie un buffer d'IDs couleur.
 * @param {string} canvasSelector - sélecteur du canvas wplace (à adapter)
 */
export function snapshotBoard(canvasSelector) {
    const cvs = document.querySelector(canvasSelector);
    if (!cvs) return null;

    const w = cvs.width,
        h = cvs.height;
    const ctx = cvs.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h).data;

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

/** Getter rapide: id de couleur à (x,y), ou -1 si hors limites. */
export function makeBoardGetter(boardWidth, colorIdxBuffer) {
    return (x, y) => {
        if (x < 0 || y < 0) return -1;
        const idx = y * boardWidth + x;
        return colorIdxBuffer[idx] ?? -1;
    };
}
