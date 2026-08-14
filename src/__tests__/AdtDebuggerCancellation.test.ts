import {
  AdtHTTP,
  debuggerListen,
  isRequestCancelled,
  REQUEST_CANCELLED_CODE
} from "../adt/index.js"

const asHttp = (request: jest.Mock) => ({ request }) as unknown as AdtHTTP

describe("debuggerListen request options", () => {
  test("keeps the existing positional call and default timeout", async () => {
    const request = jest.fn().mockResolvedValue({ body: "" })

    await expect(
      debuggerListen(asHttp(request), "user", "terminal", "ide", "DEVELOPER")
    ).resolves.toBeUndefined()

    expect(request).toHaveBeenCalledWith("/sap/bc/adt/debugger/listeners", {
      method: "POST",
      timeout: 360000000,
      qs: {
        debuggingMode: "user",
        requestUser: "DEVELOPER",
        terminalId: "terminal",
        ideId: "ide",
        checkConflict: true,
        isNotifiedOnConflict: true
      },
      signal: undefined
    })
  })

  test("passes an optional signal and timeout without changing positional arguments", async () => {
    const request = jest.fn().mockResolvedValue({ body: "" })
    const controller = new AbortController()

    await debuggerListen(
      asHttp(request),
      "terminal",
      "terminal",
      "ide",
      undefined,
      false,
      false,
      { signal: controller.signal, timeout: 5_000 }
    )

    expect(request.mock.calls[0][1]).toMatchObject({
      timeout: 5_000,
      signal: controller.signal
    })
  })

  test("preserves cancellation as a distinct error", async () => {
    const cancelled = Object.assign(new Error("request cancelled"), {
      code: REQUEST_CANCELLED_CODE
    })
    const request = jest.fn().mockRejectedValue(cancelled)

    const error = await debuggerListen(
      asHttp(request),
      "terminal",
      "terminal",
      "ide",
      undefined,
      true,
      true,
      { signal: new AbortController().signal }
    ).catch(caught => caught)

    expect(error).toBe(cancelled)
    expect(isRequestCancelled(error)).toBe(true)
  })
})
