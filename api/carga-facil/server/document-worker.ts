import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createWorker, PSM } from 'tesseract.js';
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { parseCargoMessages } from '../shared/cargo-message.js';
import { cityFromCargoText } from './municipalities.js';
import {
  personalDocumentCategories,
  vehicleDocumentCategories,
  readDocumentFields,
  type DocumentReading,
} from '../shared/document-reading.js';

const require = createRequire(import.meta.url);
type Input =
  | { buffer: Buffer; mime: string; mode: 'text' }
  | { documents: Array<{ buffer: Buffer; mime: string; name?: string }>; mode: 'document' };

process.once('message', async (input: Input) => {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    const recognize = async (image: Buffer, segmentation: PSM = PSM.AUTO) => {
      worker ??= await createWorker('por', 1, {
        langPath: join(
          dirname(require.resolve('@tesseract.js-data/por/package.json')),
          '4.0.0_best_int',
        ),
        cacheMethod: 'none',
        gzip: true,
      });
      await worker.setParameters({
        tessedit_pageseg_mode: segmentation,
      });
      return (await worker.recognize(image)).data.text;
    };

    const cropCanvas = (
      source: Canvas,
      area: { x: number; y: number; width: number; height: number },
      maxSide = 2400,
    ) => {
      const sourceWidth = Math.max(1, Math.round(source.width * area.width));
      const sourceHeight = Math.max(1, Math.round(source.height * area.height));
      const scale = Math.min(4, maxSide / Math.max(sourceWidth, sourceHeight));
      const canvas = createCanvas(
        Math.max(1, Math.round(sourceWidth * scale)),
        Math.max(1, Math.round(sourceHeight * scale)),
      );
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.filter = 'grayscale(1) contrast(1.35)';
      context.drawImage(
        source,
        Math.round(source.width * area.x),
        Math.round(source.height * area.y),
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return canvas;
    };

    const cargoTextScore = (value: string) => {
      const normalized = value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase();
      const terms = [
        'FRETE',
        'CARGA',
        'CARREGAMENTO',
        'ORIGEM',
        'DESTINO',
        'ENTREGA',
        'TON',
        'CARRETA',
        'CAMINHAO',
        'R$',
      ];
      return (
        parseCargoMessages(value, undefined, cityFromCargoText).reduce(
          (score, item) =>
            score + Object.keys(item.data.suggestion).length * 200 + item.data.details.length * 100,
          0,
        ) +
        terms.reduce((score, term) => score + (normalized.includes(term) ? 120 : 0), 0) +
        (normalized.match(/[A-Z]{3,}/g)?.length || 0) * 4 +
        (normalized.match(/\d/g)?.length || 0)
      );
    };

    const readCargoImage = async (buffer: Buffer) => {
      const image = await loadImage(buffer);
      if (image.width * image.height > 40_000_000) throw new Error('Image too large');
      const source = createCanvas(image.width, image.height);
      const sourceContext = source.getContext('2d');
      sourceContext.fillStyle = '#fff';
      sourceContext.fillRect(0, 0, source.width, source.height);
      sourceContext.drawImage(image, 0, 0);
      // Anúncios podem ocupar qualquer parte da imagem. Cortes fixos removiam
      // origem, frete e condições próximas das bordas em fotos sem moldura.
      const area = { x: 0, y: 0, width: 1, height: 1 };
      const normal = cropCanvas(source, area, 2200);
      const normalText = await recognize(normal.toBuffer('image/png'));

      // Status costuma ter letras brancas sobre uma cor forte. A versão binária
      // converte essas letras em preto sobre branco, formato em que o Tesseract
      // é muito mais preciso. Mantemos também a versão normal para anúncios de
      // fundo claro e escolhemos o resultado com mais sinais de uma carga.
      const binary = cropCanvas(source, area, 2200);
      const context = binary.getContext('2d');
      const pixels = context.getImageData(0, 0, binary.width, binary.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const luminance =
          0.2126 * pixels.data[index] +
          0.7152 * pixels.data[index + 1] +
          0.0722 * pixels.data[index + 2];
        const value = luminance > 205 ? 0 : 255;
        pixels.data[index] = value;
        pixels.data[index + 1] = value;
        pixels.data[index + 2] = value;
        pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const binaryText = await recognize(binary.toBuffer('image/png'));
      let best = cargoTextScore(binaryText) > cargoTextScore(normalText) ? binaryText : normalText;
      const items = parseCargoMessages(best, undefined, cityFromCargoText);
      // Compare também o miolo quando as barras do WhatsApp prejudicarem a leitura.
      // A imagem inteira continua candidata; não descartamos texto das bordas.
      if (
        image.height > image.width * 1.35 &&
        items.some(
          ({ data: { suggestion: found } }) =>
            !found.originCity || !found.destinationCity || !found.freight,
        )
      ) {
        const middle = cropCanvas(source, { x: 0.015, y: 0.14, width: 0.97, height: 0.73 }, 1900);
        const middleText = await recognize(middle.toBuffer('image/png'));
        if (cargoTextScore(middleText) > cargoTextScore(best)) best = middleText;
      }
      return best
        .split('\n')
        .filter((line) => !/^\s*(?:responder\b.*|(?:hoje|ontem)\s+\d{1,2}:\d{2})\s*$/i.test(line))
        .join('\n');
    };

    const readOne = async (document: { buffer: Buffer; mime: string; name?: string }) => {
      let text = '';
      if (document.mime === 'application/pdf') {
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const pdf = await getDocument({
          data: new Uint8Array(document.buffer),
          useSystemFonts: true,
        }).promise;
        try {
          for (let pageIndex = 1; pageIndex <= Math.min(pdf.numPages, 3); pageIndex++) {
            const page = await pdf.getPage(pageIndex);
            const content = await page.getTextContent();
            const pageText = content.items
              .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
              .join('');
            text += `\n${pageText}`;
            const accumulated = readDocumentFields(text);
            const category = accumulated.category || 'other';
            const hasIdentity =
              category === 'other'
                ? Boolean(accumulated.cpf || accumulated.plate || accumulated.name)
                : vehicleDocumentCategories.includes(category)
                  ? Boolean(accumulated.plate)
                  : personalDocumentCategories.includes(category)
                    ? Boolean(accumulated.cpf)
                    : false;
            // Depois que uma página revelou CPF ou placa, as seguintes ainda têm
            // seu texto extraído, mas não repetem o OCR pesado. Reconhecer apenas
            // o título "CNH" não basta para interromper a busca da identidade.
            if (!hasIdentity) {
              const base = page.getViewport({ scale: 1 });
              const viewport = page.getViewport({
                scale: Math.min(2.6, 2200 / Math.max(base.width, base.height)),
              });
              const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
              await page.render({
                canvas: canvas as never,
                canvasContext: canvas.getContext('2d') as never,
                viewport,
              }).promise;
              const plainPageText = pageText.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const crlv = /CERTIFICADO[\s\S]{0,120}LICENCIAMENTO DE VEICULO/i.test(plainPageText);
              const wrapper = /QR-?CODE|ASSINADOR SERPRO|SERPRO\.GOV/i.test(pageText);
              if (crlv) {
                // No CRLV-e, os dados úteis ocupam a metade superior e os QR
                // Codes reduzem a precisão quando a página A4 inteira é lida.
                const certificate = cropCanvas(
                  canvas,
                  { x: 0.015, y: 0.02, width: 0.97, height: 0.52 },
                  3000,
                );
                text += `\n${await recognize(certificate.toBuffer('image/png'), PSM.SPARSE_TEXT)}`;
              } else if (wrapper && canvas.height > canvas.width * 1.25) {
                // No PDF oficial da CNH-e, o cartão ocupa o canto superior
                // esquerdo e o QR Code ocupa quase toda a metade direita.
                // Recortar o cartão evita que o QR domine a leitura e amplia
                // os campos pequenos sem aumentar o consumo de memória.
                const card = cropCanvas(
                  canvas,
                  { x: 0.045, y: 0.065, width: 0.42, height: 0.235 },
                  2800,
                );
                text += `\n${await recognize(card.toBuffer('image/png'))}`;
              }
              const croppedReading = readDocumentFields(text);
              if (!croppedReading.cpf && !croppedReading.plate && !croppedReading.name)
                text += `\n${await recognize(canvas.toBuffer('image/png'), PSM.SPARSE_TEXT)}`;
            }
            page.cleanup();
          }
        } finally {
          await pdf.cleanup();
        }
      } else {
        const image = await loadImage(document.buffer);
        if (image.width * image.height > 40_000_000) throw new Error('Image too large');
        // Fotos de contas e comprovantes costumam trazer campos pequenos.
        // Ampliar antes do OCR preserva datas e abreviações como “ag” e “c/c”.
        const scale = Math.min(3, 2800 / Math.max(image.width, image.height));
        const canvas = createCanvas(
          Math.ceil(image.width * scale),
          Math.ceil(image.height * scale),
        );
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.filter = 'grayscale(1) contrast(1.35)';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        text = await recognize(canvas.toBuffer('image/png'));
      }
      const filenamePlate = document.name
        ?.toUpperCase()
        .match(/(?:^|[^A-Z0-9])([A-Z]{3}\d[A-Z0-9]\d{2})(?:[^A-Z0-9]|$)/)?.[1];
      if (filenamePlate) text += `\nPLACA ${filenamePlate}`;
      return text;
    };

    if (input.mode === 'text') {
      const text =
        input.mime === 'application/pdf'
          ? await readOne(input)
          : await readCargoImage(input.buffer);
      process.send?.({ result: { text: text.slice(0, 10_000) } });
    } else {
      const results: Array<{ result?: DocumentReading; error?: true }> = [];
      for (const document of input.documents) {
        try {
          results.push({ result: readDocumentFields(await readOne(document)) });
        } catch {
          results.push({ error: true });
        }
      }
      process.send?.({ results });
    }
  } catch {
    process.send?.({ error: true });
  } finally {
    await worker?.terminate();
    process.disconnect();
  }
});
