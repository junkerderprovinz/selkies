/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Helpers shared by the streaming cores and both dashboards: a small FIFO
 * queue, the human-readable labels for wire values, the decodability checks
 * that keep a client from asking for a stream it cannot play, and the route
 * prefix and localStorage namespace every caller derives the same way.
 * @module
 */

/** A FIFO queue over an array. */
export class Queue {
    /** @param {...*} elements Initial items, enqueued in order. */
    constructor(...elements) {
        /** @type {Array} */
        this.items = [];

        this.enqueue(...elements);
    }

    /** @param {...*} elements Items appended in order. */
    enqueue(...elements) {
        elements.forEach(element => this.items.push(element));
    }

    /**
     * Removes the oldest `count` items.
     * @param {number} [count=1] How many items to drop.
     * @returns {*} The oldest of the removed items.
     */
    dequeue(count=1) {
        return this.items.splice(0, count)[0];
    }

    /** @returns {number} */
    size() {
        return this.items.length;
    }

    /** @returns {boolean} */
    isEmpty() {
        return this.items.length===0;
    }

    /** @returns {Array} A copy of the items, oldest first. */
    toArray() {
        return [...this.items]
    }

    /** Removes the first occurrence of `element`. */
    remove(element) {
        var index = this.items.indexOf(element)
        this.items.splice(index, 1)
    }

    /** @returns {boolean} Whether `element` is queued. */
    find(element) {
        return this.items.indexOf(element) == -1 ? false: true;
    }

    /** Drops every item. */
    clear(){
        this.items.length = 0;
    }
}

import { PROBE_CODEC_STRINGS, PROBE_FULLCOLOR_STRINGS, codecOfEncoder, codecCarriesFullColor } from "./wire-codecs.js";
export { codecOfEncoder, codecCarriesFullColor };

/**
 * Human-readable names for the wire values surfaced in UIs (transport modes,
 * encoders, rate-control modes). The raw values are what the server APIs
 * speak and stay untouched; unknown values fall through unchanged so new wire
 * values render as-is. Locale-invariant technical terms, so they live here
 * once rather than in every dashboard's translation dictionaries.
 */
export const DISPLAY_LABELS = {
    websockets: "WebSockets",
    webrtc: "WebRTC",
    h264enc: "H.264 (Full Frame)",
    h265enc: "H.265 (Full Frame)",
    vp8enc: "VP8 (Full Frame)",
    vp9enc: "VP9 (Full Frame)",
    av1enc: "AV1 (Full Frame)",
    "h264enc-striped": "H.264 (Striped Frame)",
    jpeg: "JPEG (Striped Frame)",
    cbr: "CBR (Constant Bitrate)",
    crf: "CRF (Constant Quality)",
    auto: "Auto",
    h264: "H.264",
    h265: "H.265",
    vp8: "VP8",
    vp9: "VP9",
    av1: "AV1",
    mjpeg: "MJPEG",
};

/**
 * @param {string} value A wire value.
 * @returns {string} Its display label, or the value itself when it has none.
 */
export const displayLabel = (value) => DISPLAY_LABELS[value] ?? value;

/**
 * Whether a `VideoDecoder` here accepts `codec` at `width` x `height`. False
 * without WebCodecs, and when the engine throws on the question.
 * @param {string} codec A WebCodecs codec string.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<boolean>}
 */
async function decoderAccepts(codec, width, height) {
    if (typeof VideoDecoder === "undefined") return false;
    try {
        const support = await VideoDecoder.isConfigSupported({ codec, codedWidth: width, codedHeight: height });
        return !!(support && support.supported);
    } catch (err) {
        return false;
    }
}

/**
 * What this engine's `VideoDecoder` said to each codec's representative
 * configuration, once the probe has run; `null` until then. A decoder can
 * accept a configuration and still fail at `decode()`, which the core's
 * fallback ladder answers; this only keeps the settings from offering what the
 * engine refuses outright.
 * @type {Object<string, boolean>|null}
 */
let decoderSupport = null;

/**
 * Resolves once every codec has been asked of the decoder. Menus built before
 * it resolves offer every codec an engine with WebCodecs might play, and are
 * rebuilt from the answer.
 * @type {Promise<Object<string, boolean>>}
 */
export const decoderSupportReady = (async () => {
    const answers = {};
    for (const [codec, string] of Object.entries(PROBE_CODEC_STRINGS)) {
        answers[codec] = await decoderAccepts(string, 1280, 720);
    }
    decoderSupport = answers;
    return answers;
})();

/**
 * Whether this engine can play an encoder on the WebSocket transport: every
 * video mode decodes through WebCodecs' `VideoDecoder`, whose answer per codec
 * is read once it is in, while `jpeg` (striped JPEG painted through
 * `createImageBitmap`) needs nothing. An engine without WebCodecs therefore
 * still streams: the core's pre-flight pins `jpeg` instead of failing, and the
 * settings offer nothing it cannot play. The WebRTC transport decodes in the
 * browser's media stack and is not subject to this.
 * @param {string} encoder An encoder wire value.
 * @returns {boolean}
 */
export const canDecodeEncoder = (encoder) => {
    if (encoder === "jpeg") return true;
    if (typeof VideoDecoder === "undefined") return false;
    return decoderSupport === null || decoderSupport[codecOfEncoder(encoder)] !== false;
};
/**
 * @param {string[]} encoders Encoder wire values.
 * @returns {string[]} Those `canDecodeEncoder` accepts.
 */
export const decodableEncoders = (encoders) => encoders.filter(canDecodeEncoder);

/** RTP MIME type each WebRTC encoder streams. */
const RTC_MIME_TYPES = {
    h264enc: "video/h264", h265enc: "video/h265", vp8enc: "video/vp8", vp9enc: "video/vp9", av1enc: "video/av1",
};

/**
 * Whether this engine's own WebRTC stack receives an encoder's codec, from
 * `RTCRtpReceiver.getCapabilities`; an engine that cannot answer the question
 * is given the benefit of the doubt, and the server's negotiation fallback
 * answers a codec it declines.
 * @param {string} encoder An encoder wire value.
 * @returns {boolean}
 */
export const canReceiveEncoder = (encoder) => {
    const mime = RTC_MIME_TYPES[encoder];
    if (!mime) return false;
    try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        if (!caps || !Array.isArray(caps.codecs)) return true;
        return caps.codecs.some((c) => typeof c.mimeType === "string" && c.mimeType.toLowerCase() === mime);
    } catch (err) {
        return true;
    }
};
/**
 * @param {string[]} encoders Encoder wire values.
 * @returns {string[]} Those `canReceiveEncoder` accepts.
 */
export const receivableEncoders = (encoders) => encoders.filter(canReceiveEncoder);

/** Cached answers of `canDecodeFullColor`, one probe per codec. */
const fullColorProbes = {};

/**
 * Whether this engine's `VideoDecoder` will take `codec` at full colour (4:4:4).
 *
 * Engines differ on the 4:4:4 profiles (High 4:4:4 Predictive, HEVC RExt), and
 * one whose decoder lacks them cannot show the stream at all rather than
 * showing it worse, so full colour is asked of the decoder before it is asked
 * of the server. Which engines have them changes with their releases, which is
 * why this probes instead of naming them. The profile is the whole question,
 * so it is asked with the constraint bits the encoders emit, at the smallest
 * frame the level allows, since a level is a ceiling and a size beyond it is a
 * pair an implementation may reject on its own. What a real stream is decoded
 * with comes from its key frame's parameter sets instead.
 * @param {string} [codec] The codec name, `h264` by default.
 * @returns {Promise<boolean>} False for a codec without 4:4:4, and where there
 *     is no `VideoDecoder` at all.
 */
export function canDecodeFullColor(codec = "h264") {
    const string = PROBE_FULLCOLOR_STRINGS[codec];
    if (!string) return Promise.resolve(false);
    if (!fullColorProbes[codec]) fullColorProbes[codec] = decoderAccepts(string, 320, 240);
    return fullColorProbes[codec];
}

/**
 * Directory this document is served from, without a trailing slash (`''` at
 * the server root). Every request the client builds hangs off it, so a
 * deployment reverse-proxied under a subfolder reaches its own routes, and an
 * iframed client reads its own path instead of the frame's.
 * @returns {string} The path prefix, e.g. `/desk`.
 */
export function getRoutePrefix() {
    const pathname = window.location.pathname;
    const dirPath = pathname.substring(0, pathname.lastIndexOf('/') + 1);
    return dirPath.replace(/\/$/, '');
}

/**
 * The localStorage namespace every stored key is prefixed with.
 *
 * Origin and pathname only, not the full URL: a per-session `?token=` must
 * not mint a new namespace on each connect. Cores and dashboards share one
 * prefix, so this derivation is the single one they all call.
 * @returns {string} Sanitized namespace, empty outside a browser.
 */
export function getStorageAppName() {
    if (typeof window === 'undefined') return '';
    const urlForKey = window.location.origin + window.location.pathname;
    return urlForKey.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Whether the client is touch-first: its primary pointer is coarse. True on
 * phones and tablets, false on desktops -- including touch-screen laptops,
 * whose primary pointer is still the pointing device. The form factor is
 * fixed for the life of the document, so it is resolved once and available
 * to every first render; a touch-capable device this misses is still caught
 * by the first touchstart.
 * @type {boolean}
 */
export const isMobileClient =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
