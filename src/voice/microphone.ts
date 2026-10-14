const button = document.querySelector("#allow") as HTMLButtonElement;
const status = document.querySelector("#status")!;
button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    const result = await chrome.runtime.sendMessage({
      target: "voice-recorder",
      type: "VOICE_PERMISSION_GRANTED",
    });
    if (!result?.success)
      throw new Error(
        "Microphone enabled. Close this window and press the voice shortcut again.",
      );
    window.close();
  } catch (error) {
    status.textContent =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in Chrome’s site settings for this extension, then try again."
        : error instanceof Error
          ? error.message
          : "Could not access the microphone.";
    button.disabled = false;
  }
});
export {};
