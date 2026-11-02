import { defineConfig } from "C:/Users/perha/AppData/Roaming/npm/node_modules/vite/dist/node/index.js";
import { qrcode } from "C:/Users/perha/AppData/Roaming/npm/node_modules/vite-plugin-qrcode/src/index.js";
import basicSsl from "C:/Users/perha/AppData/Roaming/npm/node_modules/@vitejs/plugin-basic-ssl/dist/index.mjs";

// Drarm Vite設定（HTTPS自己署名・LAN公開・QRコード・Google Drive非依存）
export default defineConfig({
  plugins: [
    // モバイル端末でカメラAPI(getUserMedia)を利用可能にする自己署名SSL
    basicSsl(),
    // ターミナルへLAN接続用QRコードを表示
    qrcode()
  ],
  server: {
    host: true,
    port: 5173,
    watch: {
      ignored: ["**/public/dataset/**"]
    }
  }
});
