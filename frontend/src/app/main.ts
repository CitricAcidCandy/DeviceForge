import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';

const target = document.getElementById('app');
if (!target) throw new Error('应用挂载节点不存在');
mount(App, { target });
