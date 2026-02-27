// Type declarations for ?raw imports (bundled as string constants)
declare module "*.ts?raw" {
  const content: string;
  export default content;
}
