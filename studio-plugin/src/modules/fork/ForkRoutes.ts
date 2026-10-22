// Fork plugin endpoints. Communication spreads `routes` into its route map;
// ClientBroker forwards `clientEndpoints` to client peers and dispatches them
// through `routes` there (without a request context).
import CaptureRect from "./CaptureRect";
import QueryTree from "./QueryTree";
import ReadState from "./ReadState";
import ScenarioLoader from "./ScenarioLoader";
import UiLayout from "./UiLayout";
import WaitFor from "./WaitFor";
import type { StudioRequestContext } from "../../types";

type Handler = (data: Record<string, unknown>, context?: StudioRequestContext) => unknown;

const routes: Record<string, Handler> = {
	"/api/fork/capture-rect": CaptureRect.resolve,
	"/api/fork/wait-for": WaitFor.waitFor,
	"/api/fork/query-tree": QueryTree.query,
	"/api/fork/load-scenario": ScenarioLoader.load,
	"/api/fork/ui-layout": UiLayout.layout,
	"/api/fork/read-state": ReadState.read,
};

// Endpoints that read a client's own viewport, VM or DataModel, so they must run in the client peer.
const clientEndpoints = [
	"/api/fork/capture-rect",
	"/api/fork/wait-for",
	"/api/fork/query-tree",
	"/api/fork/ui-layout",
	"/api/fork/read-state",
];

export = { routes, clientEndpoints };
