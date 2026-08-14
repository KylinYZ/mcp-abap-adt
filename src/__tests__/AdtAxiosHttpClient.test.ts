import { createServer, Server } from "http"
import { AddressInfo } from "net"
import {
  AdtHTTP,
  HttpClient,
  HttpClientException,
  HttpClientOptions,
  REQUEST_CANCELLED_CODE
} from "../adt/index.js"
import { AxiosHttpClient } from "../adt/index.js"
import {
  fromException,
  isRequestCancelled
} from "../adt/index.js"

const response = {
  body: "",
  status: 200,
  statusText: "OK",
  headers: { "x-csrf-token": "token" }
}

describe("AbortSignal requests", () => {
  let server: Server
  let baseURL: string

  beforeAll(done => {
    server = createServer((request, result) => {
      if (request.url === "/hang") {
        // Leave the response pending so cancellation, rather than a server reply, ends the call.
        request.on("close", () => result.end())
        return
      }
      result.writeHead(200)
      result.end("ok")
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      baseURL = `http://127.0.0.1:${address.port}`
      done()
    })
  })

  afterAll(done => {
    server.close(done)
  })

  test("aborts an in-flight Axios request without waiting for timeout", async () => {
    const client = new AxiosHttpClient(baseURL)
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = client.request({
      url: "/hang",
      timeout: 60_000,
      signal: controller.signal
    })

    setTimeout(() => controller.abort(), 25)

    const error = await pending.catch(caught => caught)
    expect(isRequestCancelled(error)).toBe(true)
    expect(error.code).toBe(REQUEST_CANCELLED_CODE)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test("keeps requests without a signal compatible", async () => {
    const client = new AxiosHttpClient(baseURL)

    await expect(client.request({ url: "/ok" })).resolves.toMatchObject({
      body: "ok",
      status: 200
    })
  })

  test("passes a request signal through AdtHTTP and exposes stable cancellation detection", async () => {
    const requests: HttpClientOptions[] = []
    const httpClient: HttpClient = {
      request: async options => {
        requests.push(options)
        return response
      }
    }
    const http = new AdtHTTP(httpClient, "developer", "secret", "001", "EN")
    const controller = new AbortController()

    await http.request("/sap/bc/adt/test", { signal: controller.signal })

    expect(requests).toHaveLength(2)
    expect(requests[1].signal).toBe(controller.signal)

    const transportError = new HttpClientException(
      "request cancelled",
      REQUEST_CANCELLED_CODE,
      undefined,
      undefined,
      { url: "/sap/bc/adt/test" }
    )
    expect(isRequestCancelled(transportError)).toBe(true)
    expect(isRequestCancelled(fromException(transportError))).toBe(true)
    expect(isRequestCancelled(new Error("network failed"))).toBe(false)
  })
})
