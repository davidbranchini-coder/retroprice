const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── TOKEN EBAY ───────────────────────────────────────────────────────────────
let ebayToken = null;
let tokenExpiry = null;

async function getEbayToken() {
  if (ebayToken && tokenExpiry && Date.now() < tokenExpiry) return ebayToken;

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret || clientId === 'TU_CLIENT_ID_AQUI') {
    return null;
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    ebayToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
    console.log('✅ Token eBay obtenido correctamente');
    return ebayToken;
  } catch (err) {
    console.error('Error obteniendo token eBay:', err.message);
    return null;
  }
}

// ─── BUSCAR EN EBAY ───────────────────────────────────────────────────────────
async function searchEbay(query, filtros = {}) {
  const token = await getEbayToken();

  if (!token) {
    // Datos de ejemplo si no hay claves
    return {
      demo: true,
      items: [
        { titulo: `${query} — Mega Drive`, precio: '8.50', url: '#', condicion: 'Usado', ubicacion: 'Madrid, España' },
        { titulo: `${query} — SNES`, precio: '22.00', url: '#', condicion: 'Muy bueno', ubicacion: 'Barcelona, España' },
        { titulo: `${query} — CIB completo`, precio: '45.00', url: '#', condicion: 'Nuevo', ubicacion: 'Valencia, España' },
        { titulo: `${query} — Solo cartucho`, precio: '6.00', url: '#', condicion: 'Aceptable', ubicacion: 'Sevilla, España' },
      ]
    };
  }

  try {
    // Construir filtros
    const filterParts = ['buyingOptions:{FIXED_PRICE}'];

    if (filtros.condicion) {
      const condicionMap = {
        'nuevo': 'conditionIds:{1000}',
        'como_nuevo': 'conditionIds:{1500|1750|2000}',
        'muy_bueno': 'conditionIds:{2500|3000}',
        'bueno': 'conditionIds:{3500|4000}',
        'aceptable': 'conditionIds:{5000|6000}'
      };
      if (condicionMap[filtros.condicion]) filterParts.push(condicionMap[filtros.condicion]);
    }

    if (filtros.precioMin || filtros.precioMax) {
      const min = filtros.precioMin || '0';
      const max = filtros.precioMax || '10000';
      filterParts.push(`price:[${min}..${max}]`);
    }

    const params = {
      q: query,
      category_ids: '139973',
      marketplace_id: filtros.region === 'global' ? 'EBAY_US' : 'EBAY_ES',
      limit: 20,
      filter: filterParts.join(','),
      sort: filtros.orden || 'price'
    };

    const response = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: { 'Authorization': `Bearer ${token}` },
      params
    });

    const items = response.data.itemSummaries || [];
    return {
      demo: false,
      items: items.map(item => ({
        titulo: item.title,
        precio: item.price?.value || 'N/A',
        moneda: item.price?.currency || 'EUR',
        url: item.itemWebUrl,
        condicion: item.condition || 'Usado',
        ubicacion: item.itemLocation?.country || '',
        imagen: item.image?.imageUrl || null
      }))
    };
  } catch (err) {
    console.error('Error buscando en eBay:', err.message);
    return { demo: false, items: [] };
  }
}

// ─── ENDPOINT BÚSQUEDA ────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, condicion, precioMin, precioMax, region, orden, plataforma } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro de búsqueda' });

  const queryFinal = plataforma ? `${q} ${plataforma}` : q;
  console.log(`🔍 Buscando: ${queryFinal}`);

  const resultado = await searchEbay(queryFinal, { condicion, precioMin, precioMax, region, orden });
  const precios = resultado.items.map(i => parseFloat(i.precio)).filter(p => !isNaN(p));

  const stats = {
    total: resultado.items.length,
    minimo: precios.length ? Math.min(...precios).toFixed(2) : 'N/A',
    maximo: precios.length ? Math.max(...precios).toFixed(2) : 'N/A',
    medio: precios.length ? (precios.reduce((a, b) => a + b, 0) / precios.length).toFixed(2) : 'N/A'
  };

  res.json({ query: queryFinal, demo: resultado.demo, stats, items: resultado.items });
});

// ─── ARRANCAR ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ RetroPrice corriendo en http://localhost:${PORT}`);
  console.log(`🎮 Abrí tu navegador y entrá a http://localhost:${PORT}`);
});
