import { createApp } from 'vue';
import InPageApp from './ui/InPageApp.vue';
import panelCss from './ui/panel.css?inline';

const HOST_ID = 'atsusync-extension-host';

function mount() {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelCss;
  shadow.appendChild(style);

  const root = document.createElement('div');
  shadow.appendChild(root);
  createApp(InPageApp).mount(root);
}

mount();
