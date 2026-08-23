// Assets de marque pour les PDF générés : logo Regularlog + le « dessin »
// décoratif (éventail/coquille) qu'on voit en haut à droite de l'app, rastérisé
// en PNG haute résolution pour être embarqué dans le PDF (jsPDF).

export interface BrandAssets {
  logo: string; // data URL PNG
  fan: string; // data URL PNG
}

let cache: BrandAssets | null = null;

/** SVG de l'éventail (miroir de components/Decor.tsx → Fan), avec dégradé. */
function fanSvg(): string {
  const lines = Array.from({ length: 46 }, (_, i) => {
    const a = (Math.PI * i) / 45;
    const x2 = 100 - 100 * Math.cos(a);
    const y2 = 100 - 100 * Math.sin(a);
    return `<line x1="100" y1="100" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" />`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
    <defs><linearGradient id="g" x1="0" y1="1" x2="0.2" y2="0">
      <stop offset="0" stop-color="#0c2328"/><stop offset="1" stop-color="#90c57a"/>
    </linearGradient></defs>
    <path d="M0 100 A100 100 0 0 1 200 100 Z" fill="url(#g)"/>
    <g stroke="#fbfbfb" stroke-width="0.6" opacity="0.35">${lines}</g>
  </svg>`;
}

/** Rastérise un SVG en data URL PNG (retina ×3) via un canvas. */
function svgToPng(svg: string, w: number, h: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = 3;
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("canvas 2d indisponible"));
        return;
      }
      ctx.drawImage(img, 0, 0, w * scale, h * scale);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG illisible"));
    };
    img.src = url;
  });
}

/** Charge un fichier public (logo) en data URL PNG. */
async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("lecture image impossible"));
    fr.readAsDataURL(blob);
  });
}

/** Charge (et met en cache) le logo + le dessin décoratif pour le PDF. */
export async function getBrandAssets(): Promise<BrandAssets> {
  if (cache) return cache;
  const [logo, fan] = await Promise.all([
    urlToDataUrl("/logo-mark.png").catch(() => ""),
    svgToPng(fanSvg(), 200, 100).catch(() => ""),
  ]);
  cache = { logo, fan };
  return cache;
}
