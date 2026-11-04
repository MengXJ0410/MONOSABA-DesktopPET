/** 打包时注入的默认人物，用于选择 exe / 托盘图标。 */
export const BUILD_DEFAULT_CHARACTER: "hiro" | "ema" =
  import.meta.env.VITE_DEFAULT_CHARACTER === "ema" ? "ema" : "hiro";
