import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './style.css';
import 'vue-sonner/style.css';

document.documentElement.classList.add('dark');

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'requests', component: () => import('./views/RequestsView.vue') },
    { path: '/requests/:id', name: 'request', component: () => import('./views/RequestDetailView.vue'), props: true },
    { path: '/links/:id', name: 'link', component: () => import('./views/LinkView.vue'), props: (r) => ({ id: Number(r.params.id) }) },
    { path: '/tracked', name: 'tracked', component: () => import('./views/TrackedView.vue') },
    { path: '/downloads', redirect: '/tracked' },
    { path: '/sources', name: 'sources', component: () => import('./views/SourcesView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
  ],
});

createApp(App).use(router).mount('#app');
