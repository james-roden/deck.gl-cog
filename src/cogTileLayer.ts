import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer } from "@deck.gl/layers";

import type { Tile2DHeader, TileLoadProps } from "@deck.gl/geo-layers/dist/tileset-2d";
import { TILE_SIZE } from "./constants";
import CogReader from "./read/CogReader";
import CustomRendererStore from "./render/custom/rendererStore";
import renderPhoto from "./render/renderPhoto";

export class CogTileLayer extends TileLayer<ImageBitmap> {
    static layerName = "CogTileLayer";
    constructor(readonly url: string) {
        super();
    }

    async getTileData(tile: TileLoadProps): Promise<ImageBitmap> {
        const { x, y, z } = tile.index;
        try {
            const cog = CogReader(this.url);
            const rawTile = await cog.getRawTile({ z, x, y });
            const metadata = await cog.getMetadata();
            let rgba: Uint8ClampedArray;
            const renderCustom = CustomRendererStore.get(this.url);
            if (renderCustom !== undefined) {
                rgba = renderCustom(rawTile, metadata);
            } else {
                rgba = renderPhoto(rawTile, metadata);
            }
            return await createImageBitmap(new ImageData(rgba, TILE_SIZE, TILE_SIZE));
        } catch (error) {
            console.error(`Error loading COG tile ${x}/${y}/${z}:`, error);
            return this.createErrorTile(x, y, z);  // TODO let's try and only error the data bounds
        }
    }

    renderSubLayers(
        props: TileLayer["props"] & {
            id: string;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: any;
            _offset: number;
            tile: Tile2DHeader;
        },
    ): BitmapLayer {
        const { boundingBox } = props.tile;
        const west = boundingBox[0][0];
        const south = boundingBox[0][1];
        const east = boundingBox[1][0];
        const north = boundingBox[1][1];

        return new BitmapLayer(props, {
            data: undefined,
            image: props.data,
            bounds: [west, south, east, north],
        });
    }

    private createErrorTile(x: number, y: number, z: number): Promise<ImageBitmap> {
        const canvas = document.createElement("canvas");
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        const ctx = canvas.getContext("2d")!;

        ctx.fillStyle = "#FF00FF";
        ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

        ctx.fillStyle = "white";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const centerX = TILE_SIZE / 2;
        const centerY = TILE_SIZE / 2;

        ctx.fillText("Error loading", centerX, centerY - 10);
        ctx.fillText("COG tile", centerX, centerY + 5);
        ctx.fillText(`${z}/${x}/${y}`, centerX, centerY + 20);

        return createImageBitmap(canvas);
    }
}
