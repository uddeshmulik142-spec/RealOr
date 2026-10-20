import { File } from 'expo-file-system';
import {
  HttpServer,
  type HttpRequestWithSignal,
  type HttpResponse,
} from 'react-native-nitro-http-server';

export type ScanningStationPhoto = {
  id: string;
  uri: string;
  stock: string;
  focalLength: string;
  ev: number | null;
  developedTimestamp: string | null;
};

const stationHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>REAL / OR — Scanning Station</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0a0a;color:#e8e4d8}
    *{box-sizing:border-box}body{margin:0;padding:32px;max-width:1440px;margin-inline:auto}
    header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #45433c;padding-bottom:18px;margin-bottom:24px}
    h1{font-size:clamp(22px,4vw,42px);letter-spacing:.12em;margin:4px 0}.eyebrow,.meta{color:#a99c75;font-size:11px;letter-spacing:.12em}
    button{font:inherit;color:#e8e4d8;background:#1a1a18;border:1px solid #656052;padding:12px 16px;cursor:pointer}
    button:hover{border-color:#e2a638;color:#ffc15c}button:disabled{opacity:.45;cursor:wait}
    #auth{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0}input{font:inherit;background:#111;border:1px solid #45433c;color:white;padding:12px;min-width:240px}
    #status{color:#e2a638;min-height:1.5em}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px}
    .card{background:#111;padding:8px;border:1px solid #282824;cursor:zoom-in}.card img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;background:#050505}
    .card .meta{padding:9px 2px 2px;line-height:1.7;letter-spacing:.04em}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}
    dialog{width:min(96vw,1200px);max-height:94vh;background:#080808;border:1px solid #6a6250;color:#eee;padding:12px}
    dialog img{display:block;max-width:100%;max-height:80vh;margin:auto;object-fit:contain}dialog button{display:block;margin-left:auto}
    @media(max-width:560px){body{padding:16px}header{align-items:start;gap:12px;flex-direction:column}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
  <header><div><div class="eyebrow">REAL / OR · LOCAL NEGATIVE SCANNER</div><h1>SCANNING STATION</h1></div><div class="eyebrow" id="count">LOCKED</div></header>
  <form id="auth"><input id="code" type="password" autocomplete="current-password" placeholder="SESSION ACCESS CODE" aria-label="Session access code" required><button>UNLOCK ARCHIVE</button></form>
  <div id="status" role="status">Enter the access code displayed on the camera.</div>
  <div class="toolbar"><button id="export" disabled>EXPORT FULL CONTACT SHEET</button></div>
  <main id="grid" class="grid"></main>
  <dialog id="loupe"><button id="close">CLOSE</button><img id="large" alt="High-resolution negative"><div id="detail" class="meta"></div><button id="download">DOWNLOAD UNCOMPRESSED NEGATIVE</button></dialog>
  <script>
    const form=document.querySelector('#auth'),codeInput=document.querySelector('#code'),status=document.querySelector('#status'),grid=document.querySelector('#grid'),count=document.querySelector('#count'),exportButton=document.querySelector('#export'),loupe=document.querySelector('#loupe'),large=document.querySelector('#large'),detail=document.querySelector('#detail');
    let token='',photos=[],selected=null,loupeUrl=null,loupeRequest=0;
    async function api(path){const response=await fetch(path,{headers:{Authorization:'Bearer '+token}});if(!response.ok)throw new Error(response.status===401?'Access code rejected.':'Request failed ('+response.status+').');return response}
    async function loadPhoto(photo,image){const response=await api(photo.imageUri),url=URL.createObjectURL(await response.blob());image.onload=()=>URL.revokeObjectURL(url);image.onerror=()=>URL.revokeObjectURL(url);image.src=url}
    async function openLoupe(photo){const request=++loupeRequest;selected=photo;detail.textContent=[photo.stock,photo.focalLength,photo.ev===null?'EV UNRECORDED':'EV '+(photo.ev>=0?'+':'')+Number(photo.ev).toFixed(1),photo.developedTimestamp||'DATE UNAVAILABLE'].join(' · ');loupe.showModal();try{const response=await api(photo.imageUri),url=URL.createObjectURL(await response.blob());if(request!==loupeRequest||!loupe.open){URL.revokeObjectURL(url);return}if(loupeUrl)URL.revokeObjectURL(loupeUrl);loupeUrl=url;large.src=url}catch(error){if(request===loupeRequest)detail.textContent=error.message||'IMAGE UNAVAILABLE'}}
    async function unlock(){token=codeInput.value.trim();if(!token)throw new Error('Enter the access code.');const response=await api('/api/manifest');photos=await response.json();grid.replaceChildren();count.textContent=String(photos.length).padStart(2,'0')+' NEGATIVES';exportButton.disabled=photos.length===0;
      for(const [index,photo] of photos.entries()){const card=document.createElement('article');card.className='card';const image=document.createElement('img');image.loading='lazy';image.alt='Developed negative '+(index+1);const metadata=document.createElement('div');metadata.className='meta';metadata.textContent=[photo.stock,photo.focalLength,photo.ev===null?'EV —':'EV '+Number(photo.ev).toFixed(1)].join(' · ');card.append(image,metadata);grid.append(card);card.addEventListener('click',()=>void openLoupe(photo));observer.observe(card)}
      status.textContent='ARCHIVE UNLOCKED · '+photos.length+' FRAMES';}
    const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){observer.unobserve(entry.target);const index=Array.from(grid.children).indexOf(entry.target);if(index>=0)loadPhoto(photos[index],entry.target.querySelector('img')).catch(error=>{entry.target.querySelector('.meta').textContent='IMAGE UNAVAILABLE · '+error.message})}}});
    form.addEventListener('submit',event=>{event.preventDefault();status.textContent='VERIFYING SESSION…';unlock().catch(error=>{token='';status.textContent=error.message})});
    document.querySelector('#close').addEventListener('click',()=>loupe.close());
    loupe.addEventListener('close',()=>{loupeRequest++;large.removeAttribute('src');if(loupeUrl)URL.revokeObjectURL(loupeUrl);loupeUrl=null});
    document.querySelector('#download').addEventListener('click',async()=>{if(!selected)return;try{const index=photos.indexOf(selected)+1;const response=await api(selected.imageUri);const url=URL.createObjectURL(await response.blob());const anchor=document.createElement('a');anchor.href=url;anchor.download='realor-frame-'+String(index).padStart(3,'0')+'.jpg';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){status.textContent=error.message||'NEGATIVE DOWNLOAD FAILED'}});
    exportButton.addEventListener('click',async()=>{exportButton.disabled=true;status.textContent='ASSEMBLING CONTACT SHEET…';try{const columns=5,cellWidth=180,cellHeight=230,rows=Math.ceil(photos.length/columns),canvas=document.createElement('canvas');canvas.width=columns*cellWidth;canvas.height=rows*cellHeight;const context=canvas.getContext('2d');if(!context)throw new Error('Canvas is unavailable.');context.fillStyle='#0a0a0a';context.fillRect(0,0,canvas.width,canvas.height);
        for(let i=0;i<photos.length;i++){const response=await api(photos[i].imageUri),url=URL.createObjectURL(await response.blob());try{const image=new Image();image.src=url;await image.decode();const x=(i%columns)*cellWidth,y=Math.floor(i/columns)*cellHeight;context.drawImage(image,x,y,cellWidth,cellHeight-30);context.fillStyle='#d3a34c';context.font='11px monospace';context.fillText(String(i+1).padStart(3,'0')+' · '+photos[i].stock.slice(0,18),x+5,y+cellHeight-10)}finally{URL.revokeObjectURL(url)}}
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.88));if(!blob)throw new Error('Contact sheet export failed.');const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='realor-contact-sheet.jpg';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='CONTACT SHEET EXPORTED';
      }catch(error){status.textContent=error.message||'CONTACT SHEET EXPORT FAILED'}finally{exportButton.disabled=false}});
  </script>
</body>
</html>`;

function jsonResponse(statusCode: number, value: unknown): HttpResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(value),
  };
}

function authorized(request: HttpRequestWithSignal, accessCode: string): boolean {
  const authorization = Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === 'authorization',
  )?.[1];
  return authorization === `Bearer ${accessCode}`;
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function createScanningStationHandler(
  photos: ScanningStationPhoto[],
  accessCode: string,
  onBytesServed: (bytes: number) => void,
): (request: HttpRequestWithSignal) => Promise<HttpResponse> {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  const handler = async (
    request: HttpRequestWithSignal,
  ): Promise<HttpResponse> => {
    const path = new URL(request.path, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/') {
      return {
        statusCode: 200,
        headers: responseHeaders('text/html; charset=utf-8'),
        body: stationHtml,
      };
    }

    if (request.method !== 'GET') {
      return jsonResponse(405, { error: 'Method not allowed.' });
    }
    if (!path.startsWith('/api/')) {
      return jsonResponse(404, { error: 'Not found.' });
    }
    if (!authorized(request, accessCode)) {
      return jsonResponse(401, { error: 'Valid session access code required.' });
    }

    if (path === '/api/manifest') {
      const manifest = photos.map((photo) => ({
        id: photo.id,
        stock: photo.stock,
        focalLength: photo.focalLength,
        ev: photo.ev,
        developedTimestamp: photo.developedTimestamp,
        imageUri: `/api/image/${encodeURIComponent(photo.id)}`,
      }));
      return jsonResponse(200, manifest);
    }

    const imageMatch = path.match(/^\/api\/image\/([^/]+)$/);
    if (!imageMatch) return jsonResponse(404, { error: 'Not found.' });

    let id: string;
    try {
      id = decodeURIComponent(imageMatch[1]);
    } catch {
      return jsonResponse(400, { error: 'Invalid frame identifier.' });
    }
    const photo = photosById.get(id);
    if (!photo) return jsonResponse(404, { error: 'Frame not found.' });

    try {
      const bytes = await new File(photo.uri).bytes();
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      onBytesServed(bytes.byteLength);
      return {
        statusCode: 200,
        headers: {
          ...responseHeaders('image/jpeg'),
          'Content-Length': String(bytes.byteLength),
          'Content-Disposition': 'attachment; filename="realor-negative.jpg"',
        },
        body,
      };
    } catch (error) {
      console.error('Unable to read an archived negative for transmission.', error);
      return jsonResponse(500, { error: 'The selected negative could not be read.' });
    }
  };

  return handler;
}

export async function startScanningStationServer(
  photos: ScanningStationPhoto[],
  accessCode: string,
  onBytesServed: (bytes: number) => void,
  host: string,
  port = 8080,
): Promise<{ server: HttpServer; port: number }> {
  const server = new HttpServer();
  const handler = createScanningStationHandler(
    photos,
    accessCode,
    onBytesServed,
  );
  let actualPort = await server.start(port, handler, { host });
  if (actualPort === 0 && port !== 0) {
    actualPort = await server.start(0, handler, { host });
  }
  if (actualPort === 0) {
    throw new Error('The scanning station could not bind to a local port.');
  }
  return { server, port: actualPort };
}
