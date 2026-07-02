const sidebar = document.createElement('div');
sidebar.id = 'my-ext-sidebar';
sidebar.style.cssText = `
  position: fixed; top: 0; right: 0; height: 100%; width: 280px;
  background: #181818; color: #fff; z-index: 9999;
  padding: 16px; box-shadow: -2px 0 8px rgba(0,0,0,0.5);
  display: none; font-family: sans-serif;
`;
sidebar.innerHTML = `<h3>10s Checkpoint</h3><p>Triggered!</p>`;
document.body.appendChild(sidebar);

function showSidebar() {
  sidebar.style.display = 'block';
}

function hideSidebar() {
  sidebar.style.display = 'none';
}

// Listen for the trigger from content.js
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'timeupdate') {
    showSidebar();
  }
});