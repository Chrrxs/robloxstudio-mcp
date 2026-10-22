// Fork plugin endpoints. Communication spreads `routes` into its route map;
// ClientBroker forwards `clientEndpoints` to client peers and dispatches them
// through `routes` there.
import CaptureRect from "./CaptureRect";

type Handler = (data: Record<string, unknown>) => unknown;

const routes: Record<string, Handler> = {
	"/api/fork/capture-rect": CaptureRect.resolve,
};

// Endpoints that read the client's own viewport or state, so they must run in the client peer.
const clientEndpoints = ["/api/fork/capture-rect"];

export = { routes, clientEndpoints };
