// Replace the `matterbridge` package with the stubs in this folder for every module loaded after this one.
import { registerHooks } from 'node:module';

const stubs: Record<string, string> = {
  matterbridge: new URL('./matterbridge-stub.ts', import.meta.url).href,
  'matterbridge/matter/clusters': new URL('./clusters-stub.ts', import.meta.url).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubs[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
