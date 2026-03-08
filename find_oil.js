const { ChromaClient } = require('chromadb');
async function main() {
  const client = new ChromaClient({ path: 'http://chroma:8000' });
  const col = await client.getCollection({ name: 'tenant_kumara-stores-mmi1hn8v' });
  const all = await col.get({ include: ['documents', 'metadatas'] });
  for (let i = 0; i < all.documents.length; i++) {
    const doc = all.documents[i];
    if (doc.toLowerCase().includes('coconut oil')) {
      console.log('CHUNK ' + i + ' (id: ' + all.ids[i] + '):');
      console.log('META:', JSON.stringify(all.metadatas[i]));
      console.log('TEXT:', doc.substring(0, 300));
      console.log('---');
    }
  }
}
main().catch(console.error);