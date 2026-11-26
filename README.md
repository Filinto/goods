# Cesto — Lista de Compras

Uma aplicação de compras mobile-first, criada com React, TypeScript e Vite. Fotografe uma etiqueta de preço com a câmara do telemóvel, confirme ou edite os dados reconhecidos e acompanhe uma estimativa do total.

## Executar localmente

1. Instale o Node.js (20.19+ ou 22.12+).
2. Execute `npm install`.
3. Execute `npm run dev` e abra o endereço local no computador ou telemóvel. Para testar no telemóvel, o servidor tem de estar acessível na rede local; o acesso à câmara requer HTTPS ou localhost.
4. No telemóvel, toque em **Digitalizar etiqueta de preço** e permita o acesso à câmara. Também pode escolher uma fotografia existente.

Use `npm run build` para criar uma versão de produção e `npm run lint` para executar o linter.

## Funcionalidades

- Ecrãs de criação de conta e início de sessão para demonstração local.
- Captura de fotografia e reconhecimento de texto (OCR) no navegador, com Tesseract.js em português.
- Confirmação dos dados reconhecidos: nome do artigo, preço, preço por kg e quantidade antes de adicionar à lista.
- Lista de compras, controlo de quantidades, total estimado, histórico de compras concluídas e criação de novas listas.
- Interface responsiva para telemóvel e computador e uma versão PWA instalável básica.
- Formatos de data e moeda de Portugal (EUR).

## Limitações do protótipo

- **As contas são apenas para demonstração e ficam neste dispositivo.** O e-mail e um hash da palavra-passe com salt são guardados no armazenamento do navegador. Não existe servidor, autenticação segura, recuperação de palavra-passe nem sincronização entre dispositivos. É necessário integrar um backend de autenticação antes de usar em produção.
- As listas e fotografias comprimidas ficam no localStorage do navegador, neste dispositivo. A limpeza dos dados do navegador apaga essa informação e o espaço disponível é limitado.
- O OCR é uma estimativa e pode exigir a transferência inicial do modelo de idioma. Confirme sempre os dados antes de adicionar um artigo. O total apresentado está em euros e não inclui descontos nem impostos.
- O service worker é registado nas versões de produção. O OCR pode precisar de ligação à Internet se o modelo ainda não tiver sido transferido.
