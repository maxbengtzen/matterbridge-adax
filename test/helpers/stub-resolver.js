const stubs = {
  matterbridge: new URL('./matterbridge-stub.js', import.meta.url).href,
  'matterbridge/matter/clusters': new URL('./clusters-stub.js', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier in stubs) return { url: stubs[specifier], shortCircuit: true };
  return nextResolve(specifier, context);
}
