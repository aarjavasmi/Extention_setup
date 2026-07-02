// content-script.js
function getCurrentTime() {
    const video = document.querySelector('video');
    return video ? video.currentTime : null;

}
let last_trigered=-1;

function every10min(video){
    video.pause();
    chrome.runtime.sendMessage({ type: 'timeupdate' });
}

function addevlis(video) {
    video.addEventListener('timeupdate', () => {
        const currentTime = getCurrentTime();
        if (currentTime !== null && Math.floor(currentTime) % 600 === 0 && Math.floor(currentTime) !== last_trigered && Math.floor(currentTime)!=0) {
            last_trigered=Math.floor(currentTime);
            every10min(video);
        }
    });
}

const video = document.querySelector('video');
if (video) addevlis(video);
