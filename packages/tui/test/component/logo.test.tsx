/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Logo } from "../../src/component/logo"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const wordmark = ["█  █ █  █ █▀▀▀ █  █ █▀▀▀", "▀▄▄▀ █  █ ▀▀▀█ █  █ ▀▀▀█", "▀▀  ▀▀▀█ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"]
const mark = ["█  █", "▀▄▄▀", "▀▀"]

test.each<{ width: number; height: number; rows: string[] }>([
  { width: 120, height: 40, rows: [...wordmark, "MyVy confidential"] },
  { width: 28, height: 24, rows: [...wordmark, "MyVy confidential"] },
  { width: 27, height: 24, rows: [...mark, "MyVy confidential"] },
  { width: 21, height: 24, rows: [...mark, "MyVy confidential"] },
  { width: 20, height: 24, rows: [...mark, "MyVy"] },
  { width: 12, height: 24, rows: [...mark, "MyVy"] },
  { width: 120, height: 11, rows: [] },
])("home logo fits the terminal (%o)", async (input) => {
  await using temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <box>
              <Logo />
              <text>ready</text>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width, height: input.height },
  )
  try {
    app.renderer.start()
    const frame = await app.waitForFrame((frame) => frame.includes("ready"))
    const rows = frame
      .split("\n")
      .map((row) => row.trim())
      .filter((row) => row && row !== "ready")
    expect(rows).toEqual(input.rows)
  } finally {
    app.renderer.destroy()
  }
})
