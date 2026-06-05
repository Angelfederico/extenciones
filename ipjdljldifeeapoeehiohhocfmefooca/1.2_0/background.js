chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "download") {
        const filename = request.filename || `gemini_output_${request.index + 1}_${Date.now()}.jpg`;

        chrome.downloads.download({
            url: request.url,
            filename: filename
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download failed:", chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError });
            } else {
                // Wait for the download to complete to get the final filename
                const checkDownload = (delta) => {
                    if (delta.id === downloadId && delta.state) {
                        if (delta.state.current === 'complete') {
                            chrome.downloads.onChanged.removeListener(checkDownload);
                            chrome.downloads.search({ id: downloadId }, (results) => {
                                if (results && results[0]) {
                                    sendResponse({ success: true, downloadId: downloadId, filename: results[0].filename });
                                } else {
                                    sendResponse({ success: true, downloadId: downloadId, filename: filename }); // Fallback
                                }
                            });
                        } else if (delta.state.current === 'interrupted') {
                            chrome.downloads.onChanged.removeListener(checkDownload);
                            sendResponse({ success: false, error: "Download interrupted" });
                        }
                    }
                };
                chrome.downloads.onChanged.addListener(checkDownload);
            }
        });
        return true; // Keep channel open for async response
    }

    if (request.action === "waitForNextDownload") {
        // Listen for the next download creation
        const listener = (downloadItem) => {
            chrome.downloads.onCreated.removeListener(listener);

            // Wait for it to complete to get the filename
            const changeListener = (delta) => {
                if (delta.id === downloadItem.id && delta.state) {
                    if (delta.state.current === 'complete') {
                        chrome.downloads.onChanged.removeListener(changeListener);
                        chrome.downloads.search({ id: downloadItem.id }, (results) => {
                            if (results && results[0]) {
                                sendResponse({ success: true, filename: results[0].filename });
                            } else {
                                sendResponse({ success: true, filename: "unknown_file.jpg" });
                            }
                        });
                    } else if (delta.state.current === 'interrupted') {
                        chrome.downloads.onChanged.removeListener(changeListener);
                        sendResponse({ success: false, error: "Download interrupted" });
                    }
                }
            };
            chrome.downloads.onChanged.addListener(changeListener);
        };

        chrome.downloads.onCreated.addListener(listener);

        // Timeout after 45 seconds if no download starts
        setTimeout(() => {
            if (chrome.downloads.onCreated.hasListener(listener)) {
                chrome.downloads.onCreated.removeListener(listener);
                sendResponse({ success: false, error: "Timeout waiting for download" });
            }
        }, 10000);

        return true; // Keep channel open
    }
});
