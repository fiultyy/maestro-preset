// Node half of the ui-agent-pool client plugin. The empty apply exists so the
// plugin appears in the host Loader; the browser half ships the pool surfaces
// through exports["./client"], discovered from the dsh.client declaration.
function apply() {}

export { apply };
