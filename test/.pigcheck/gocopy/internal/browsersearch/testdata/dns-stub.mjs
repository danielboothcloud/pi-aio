// Fixed DNS table for the browser-search golden generator. The Go test reads
// the same table from golden.json ("dnsTable").
export const TABLE = {
	"public.test": [{ address: "93.184.216.34", family: 4 }],
	"two.test": [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
	"rebind.test": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
	"loop6.test": [{ address: "::1", family: 6 }],
	"mapped.test": [{ address: "::ffff:7f00:1", family: 6 }],
	"ula.test": [{ address: "fd12::1", family: 6 }],
	"empty.test": [],
};
export function lookup(hostname, options, callback) {
	const done = typeof options === "function" ? options : callback;
	const rows = TABLE[hostname];
	queueMicrotask(() => {
		if (rows) done(null, rows);
		else {
			const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
			error.code = "ENOTFOUND";
			done(error);
		}
	});
}
export default { lookup };
