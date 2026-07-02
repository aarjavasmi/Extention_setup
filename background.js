chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === "timeupdate") {
        chrome.tabs.sendMessage(sender.tab.id, {
            type: "timeupdate"
        });
    }
});