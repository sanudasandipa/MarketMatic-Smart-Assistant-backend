const embed = require('/app/src/services/embeddingService');
const chroma = require('/app/src/services/chromaService');

(async () => {
  const q = 'What time do you close on Friday?';
  const emb = await embed.getEmbedding(q);
  const results = await chroma.queryCollection('medihelp-mmg76fsx', emb, 5);
  console.log('Query:', q);
  if (results && results.documents && results.documents[0]) {
    for (let i = 0; i < results.documents[0].length; i++) {
      const dist = results.distances[0][i];
      const doc = results.documents[0][i].substring(0, 200);
      const meta = results.metadatas[0][i];
      console.log('[' + i + '] dist=' + dist.toFixed(4) + ' chunk=' + meta.chunkIndex + ' doc=' + meta.documentName);
      console.log('    ' + doc);
    }
  }
  process.exit(0);
})();
