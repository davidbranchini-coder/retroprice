const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ENDPOINT VERIFICACIÓN EBAY ──────────────────────────────────────────────
app.get('/ebay/deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Sin challenge_code' });
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN || 'retroprice2025ABCDEFGHabcdefgh12';
  const endpoint = 'https://retroprice.onrender.com/ebay/deletion';
  const hash = crypto.createHash('sha256').update(challengeCode + verificationToken + endpoint).digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/ebay/deletion', (req, res) => res.status(200).json({ status: 'ok' }));

// ─── TOKEN BROWSE API ─────────────────────────────────────────────────────────
let ebayToken = null;
let tokenExpiry = null;

async function getEbayToken() {
  if (ebayToken && tokenExpiry && Date.now() < tokenExpiry) return ebayToken;
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret || clientId === 'TU_CLIENT_ID_AQUI') return null;
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
      { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    ebayToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
    console.log('✅ Token eBay obtenido');
    return ebayToken;
  } catch (err) {
    console.error('Error token eBay:', err.message);
    return null;
  }
}

// ─── BUSCAR ACTIVOS (Browse API) ──────────────────────────────────────────────
async function searchEbayActivos(query, filtros = {}) {
  const token = await getEbayToken();
  if (!token) return { demo: true, total: 4, items: demoItems(query) };

  try {
    const filterParts = ['buyingOptions:{FIXED_PRICE}'];
    if (filtros.condicion) {
      const map = { nuevo: 'conditionIds:{1000}', como_nuevo: 'conditionIds:{1500|1750|2000}', muy_bueno: 'conditionIds:{2500|3000}', bueno: 'conditionIds:{3500|4000}', aceptable: 'conditionIds:{5000|6000}' };
      if (map[filtros.condicion]) filterParts.push(map[filtros.condicion]);
    }
    if (filtros.precioMin || filtros.precioMax) {
      filterParts.push(`price:[${filtros.precioMin || 0}..${filtros.precioMax || 10000}],currency:EUR`);
    }
    const esEspana = filtros.region !== 'global';
    if (esEspana) filterParts.push('itemLocationCountry:ES');
    const marketplaceId = esEspana ? 'EBAY_ES' : 'EBAY_US';

    const response = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplaceId, 'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=ES,zip=00000' },
      params: { q: query, category_ids: '139973', marketplace_id: marketplaceId, limit: 100, filter: filterParts.join(','), sort: filtros.orden || 'price' }
    });

    const items = response.data.itemSummaries || [];
    return {
      demo: false,
      total: response.data.total || 0,
      items: items.map(i => ({ titulo: i.title, precio: i.price?.value || 'N/A', url: i.itemWebUrl, condicion: i.condition || 'Used', ubicacion: i.itemLocation?.country || '', imagen: i.image?.imageUrl || null, vendido: false }))
    };
  } catch (err) {
    console.error('Error activos:', err.message);
    return { demo: false, total: 0, items: [] };
  }
}

// ─── BUSCAR FINALIZADOS/VENDIDOS (Finding API) ────────────────────────────────
async function searchEbayFinalizados(query, filtros = {}, soloVendidos = false) {
  const clientId = process.env.EBAY_CLIENT_ID;
  if (!clientId || clientId === 'TU_CLIENT_ID_AQUI') return { demo: true, total: 4, items: demoItems(query) };

  try {
    const esEspana = filtros.region !== 'global';

    const params = {
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': clientId,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': query,
      'paginationInput.entriesPerPage': '100',
      'sortOrder': filtros.orden === '-price' ? 'PricePlusShippingHighest' : 'PricePlusShippingLowest',
      'outputSelector(0)': 'SellingStatus',
      'outputSelector(1)': 'PictureURLLarge'
    };

    let filterIndex = 0;

    if (soloVendidos) {
      params[`itemFilter(${filterIndex}).name`] = 'SoldItemsOnly';
      params[`itemFilter(${filterIndex}).value`] = 'true';
      filterIndex++;
    }

    if (esEspana) {
      params[`itemFilter(${filterIndex}).name`] = 'LocatedIn';
      params[`itemFilter(${filterIndex}).value`] = 'ES';
      filterIndex++;
    }

    if (filtros.precioMin) {
      params[`itemFilter(${filterIndex}).name`] = 'MinPrice';
      params[`itemFilter(${filterIndex}).value`] = filtros.precioMin;
      params[`itemFilter(${filterIndex}).paramName`] = 'Currency';
      params[`itemFilter(${filterIndex}).paramValue`] = 'EUR';
      filterIndex++;
    }

    if (filtros.precioMax) {
      params[`itemFilter(${filterIndex}).name`] = 'MaxPrice';
      params[`itemFilter(${filterIndex}).value`] = filtros.precioMax;
      params[`itemFilter(${filterIndex}).paramName`] = 'Currency';
      params[`itemFilter(${filterIndex}).paramValue`] = 'EUR';
      filterIndex++;
    }

    const url = 'https://svcs.ebay.com/services/search/FindingService/v1';

    console.log(`🔍 Finding API | Vendidos: ${soloVendidos} | España: ${esEspana}`);

    const response = await axios.get(url, { params });

    const result = response.data?.findCompletedItemsResponse?.[0];
    const rawItems = result?.searchResult?.[0]?.item || [];
    const totalEntries = parseInt(result?.paginationOutput?.[0]?.totalEntries?.[0]) || 0;

    console.log(`✅ Finding API devolvió ${rawItems.length} items de ${totalEntries} totales`);

    const items = rawItems.map(i => {
      const sellingStatus = i.sellingStatus?.[0];
      const precio = sellingStatus?.currentPrice?.[0]?.['__value__'] || sellingStatus?.convertedCurrentPrice?.[0]?.['__value__'] || 'N/A';
      const vendido = sellingStatus?.sellingState?.[0] === 'EndedWithSales';
      return {
        titulo: i.title?.[0] || '',
        precio,
        url: i.viewItemURL?.[0] || '#',
        condicion: i.condition?.[0]?.conditionDisplayName?.[0] || 'Usado',
        ubicacion: i.country?.[0] || '',
        imagen: i.galleryURL?.[0] || null,
        vendido,
        fechaFin: i.listingInfo?.[0]?.endTime?.[0] || ''
      };
    });

    return { demo: false, total: totalEntries, items };
  } catch (err) {
    console.error('Error finalizados:', err.message);
    if (err.response) console.error('Response:', JSON.stringify(err.response.data).slice(0, 500));
    return { demo: false, total: 0, items: [] };
  }
}

// ─── DEMO ITEMS ───────────────────────────────────────────────────────────────
function demoItems(query) {
  return [
    { titulo: `${query} — Mega Drive`, precio: '8.50', url: '#', condicion: 'Used', ubicacion: 'ES', imagen: null },
    { titulo: `${query} — SNES`, precio: '22.00', url: '#', condicion: 'Very Good', ubicacion: 'ES', imagen: null },
    { titulo: `${query} — CIB`, precio: '45.00', url: '#', condicion: 'New', ubicacion: 'ES', imagen: null },
    { titulo: `${query} — Cartucho`, precio: '6.00', url: '#', condicion: 'Acceptable', ubicacion: 'ES', imagen: null },
  ];
}

// ─── ENDPOINT BÚSQUEDA ────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, condicion, precioMin, precioMax, region, orden, plataforma, tipo } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro de búsqueda' });

  const queryFinal = plataforma ? `${q} ${plataforma}` : q;
  const filtros = { condicion, precioMin, precioMax, region: region || 'es', orden };

  console.log(`🔍 Buscando: ${queryFinal} | Tipo: ${tipo || 'activos'} | Región: ${filtros.region}`);

  let resultado;
  if (tipo === 'finalizados') {
    resultado = await searchEbayFinalizados(queryFinal, filtros, false);
  } else if (tipo === 'vendidos') {
    resultado = await searchEbayFinalizados(queryFinal, filtros, true);
  } else {
    resultado = await searchEbayActivos(queryFinal, filtros);
  }

  const precios = resultado.items.map(i => parseFloat(i.precio)).filter(p => !isNaN(p));
  const stats = {
    total: resultado.total || resultado.items.length,
    minimo: precios.length ? Math.min(...precios).toFixed(2) : 'N/A',
    maximo: precios.length ? Math.max(...precios).toFixed(2) : 'N/A',
    medio: precios.length ? (precios.reduce((a, b) => a + b, 0) / precios.length).toFixed(2) : 'N/A'
  };

  res.json({ query: queryFinal, demo: resultado.demo, stats, items: resultado.items, total: resultado.total });
});

// ─── ARRANCAR ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ RetroPrice corriendo en http://localhost:${PORT}`);
  console.log(`🎮 Abrí tu navegador y entrá a http://localhost:${PORT}`);
});
