import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import {
    PASTEBIN_API_POST_URL,
    PASTEBIN_API_RAW_URL,
    PASTEBIN_API_RAW_URL_PROXIED,
} from "@/maps/api/constants";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const mapToObj = <T, K extends string, V>(
    arr: T[],
    fn: (item: T) => [K, V],
) => Object.fromEntries(arr.map(fn));

// CompressionStream and DecompressionStream only exist from Safari/iPadOS 16.4 on
export const compress = async (
    str: string,
    encoding = "deflate" as CompressionFormat,
): Promise<string> => {
    if (typeof CompressionStream !== "function") {
        throw new Error("CompressionStream is not supported by this browser");
    }

    const byteArray = new TextEncoder().encode(str);
    const cs = new CompressionStream(encoding);
    const writer = cs.writable.getWriter();
    writer.write(byteArray);
    writer.close();
    const arrayBuffer = await new Response(cs.readable).arrayBuffer();

    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
};

export const decompress = async (
    base64String: string,
    encoding = "deflate" as CompressionFormat,
): Promise<string> => {
    if (typeof DecompressionStream !== "function") {
        throw new Error("DecompressionStream is not supported by this browser");
    }

    const regularBase64 = base64String.replace(/-/g, "+").replace(/_/g, "/");
    const paddedBase64 =
        regularBase64 + "=".repeat((4 - (regularBase64.length % 4)) % 4);

    const binaryString = atob(paddedBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Piped rather than written with unawaited writer.write()/close(), whose promises
    // would become unhandled rejections when a damaged link makes the stream error
    const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream(encoding));
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(arrayBuffer);
};

export async function uploadToPastebin(
    apiKey: string,
    data: string,
): Promise<string> {
    const formData = new FormData();
    formData.append("api_option", "paste");
    formData.append("api_dev_key", apiKey);
    formData.append("api_paste_code", data);
    formData.append("api_paste_private", "1"); // 1 for unlisted
    formData.append("api_paste_expire_date", "N"); // N for never

    const response = await fetch(PASTEBIN_API_POST_URL, {
        method: "POST",
        body: formData,
    });

    const responseText = await response.text();
    if (!response.ok || responseText.startsWith("Bad API request,")) {
        throw new Error("Pastebin API error: " + responseText);
    }

    return responseText;
}

export async function fetchFromPastebin(pasteId: string): Promise<string> {
    let response;
    try {
        // prefer querying Pastebin directly since CORS proxy is unreliable
        response = await fetch(PASTEBIN_API_RAW_URL + pasteId);
    } catch {
        // CORS error; happens if the paste is not owned by a Pastebin Pro user
        response = await fetch(PASTEBIN_API_RAW_URL_PROXIED + pasteId);
    }

    if (!response.ok) {
        throw new Error(
            "Failed to fetch from Pastebin: " + response.statusText,
        );
    }

    return response.text();
}

/**
 * Reads text from the clipboard, falling back to a paste prompt where reading is
 * blocked (e.g. Firefox on Android unless its own "Paste" popup is tapped)
 */
export async function readClipboardText(): Promise<string> {
    try {
        return await navigator.clipboard.readText();
    } catch {
        const text = window.prompt("Couldn't read the clipboard. Paste here:");
        if (text === null) throw new Error("Nothing pasted");
        return text;
    }
}

/**
 * onOpenAutoFocus handler for dialogs that start with a text field. On touch,
 * focusing it would bring up the on-screen keyboard over the dialog, so focus the
 * dialog itself instead (else focus stays on the tapped element behind it).
 */
export const focusDialogOnTouch = (e: Event) => {
    if (window.matchMedia("(pointer: coarse)").matches) {
        e.preventDefault();
        (e.currentTarget as HTMLElement).focus();
    }
};

/**
 * Writes text to the clipboard
 * @returns whether the write worked. It fails where the Clipboard API is missing, and in
 * WebKit when the tap that allowed it is used up (e.g. by a share sheet) or older than 5 s.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Open native share sheet or fallback to sending to clipboard
 * @param url URL to share
 * @param forceClipboard Whether to force usage of the clipboard (instead of share sheet)
 * @returns `true` for native success, `"cancelled"` when the user closed the share sheet, `"clipboard"` for clipboard success and `false` for both native and fallback failure
 */
export async function shareOrFallback(
    url: string,
    forceClipboard = false,
): Promise<boolean | "clipboard" | "cancelled"> {
    if (!forceClipboard && navigator.share) {
        try {
            await navigator.share({ url });
            return true;
        } catch (error) {
            // Closing the share sheet without picking a target rejects with AbortError
            if ((error as Error | undefined)?.name === "AbortError") {
                return "cancelled";
            }
            // Any other failure (e.g. NotAllowedError) falls back to the clipboard
        }
    }

    return (await copyToClipboard(url)) ? "clipboard" : false;
}
