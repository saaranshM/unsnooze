import tmux from './multiplexers/tmux.js';
import zellij from './multiplexers/zellij.js';
import { getConfig } from './settings.js';

const NAMES = ['tmux', 'zellij'];

export function createMultiplexerFactory({
  backends = { tmux, zellij },
  getSetting = () => getConfig('multiplexer'),
  env = process.env,
} = {}) {
  const cache = new Map();

  const prototypeFor = name => {
    if (!NAMES.includes(name) || !backends[name]) {
      throw new Error(`unsnooze: unknown multiplexer "${name}"`);
    }
    if (!cache.has(name)) cache.set(name, backends[name]);
    return cache.get(name);
  };

  const isAvailable = name => {
    try { return prototypeFor(name).available(); } catch { return false; }
  };

  const resolveName = explicit => {
    if (explicit && explicit !== 'auto') return explicit;

    let configured = 'auto';
    try { configured = getSetting() || 'auto'; } catch { /* pre-setting compatibility */ }
    if (configured !== 'auto') return configured;

    if (env.ZELLIJ) return 'zellij';
    if (env.TMUX) return 'tmux';

    const tmuxInstalled = isAvailable('tmux');
    const zellijInstalled = isAvailable('zellij');
    if (tmuxInstalled !== zellijInstalled) return tmuxInstalled ? 'tmux' : 'zellij';
    return 'tmux';
  };

  const getMultiplexer = (name, { owner = null } = {}) => {
    const prototype = prototypeFor(resolveName(name));
    return prototype.bind ? prototype.bind(owner) : prototype;
  };

  return {
    getMultiplexer,
    available: name => prototypeFor(name).available(),
    inside: name => prototypeFor(name).inside(),
  };
}

const factory = createMultiplexerFactory();

export const getMultiplexer = (...args) => factory.getMultiplexer(...args);
export const available = (...args) => factory.available(...args);
export const inside = (...args) => factory.inside(...args);
