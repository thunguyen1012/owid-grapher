import React from "react"
import * as fs from "fs-extra"
import * as path from "path"

import * as express from "express"
import { queryMysql } from "../db/db"
import { getGrapherById } from "../db/model/Chart"
import { getBlockContent } from "../db/wpdb"

import {
    EXPLORER_FILE_SUFFIX,
    ExplorerProgram,
} from "../explorer/ExplorerProgram"
import { Router } from "express"
import { GIT_CMS_DIR } from "../gitCms/GitCmsConstants"
import { ExplorerPage } from "../site/ExplorerPage"
import {
    EXPLORERS_GIT_CMS_FOLDER,
    EXPLORERS_PREVIEW_ROUTE,
    ExplorersRoute,
    ExplorersRouteGrapherConfigs,
    ExplorersRouteQueryParam,
    ExplorersRouteResponse,
    DefaultNewExplorerSlug,
} from "../explorer/ExplorerConstants"
import simpleGit from "simple-git"
import { slugify } from "../clientUtils/Util"
import { GrapherInterface } from "../grapher/core/GrapherInterface"
import { Grapher } from "../grapher/core/Grapher"
import { GitCommit } from "../clientUtils/owidTypes"
import ReactDOMServer from "react-dom/server"

const git = simpleGit({
    baseDir: GIT_CMS_DIR,
    binary: "git",
    maxConcurrentProcesses: 1,
})

const EXPLORERS_FOLDER = `${GIT_CMS_DIR}/${EXPLORERS_GIT_CMS_FOLDER}/`

type ExpressRouter = {
    [route: string]: (
        req: express.Request,
        res: express.Response
    ) => Promise<any>
}

export const ExplorerApiRoutes: ExpressRouter = {}

ExplorerApiRoutes["/errorTest.csv"] = async (req, res) => {
    // Add `table http://localhost:3030/admin/api/errorTest.csv?code=404` to test fetch download failures
    const code =
        req.query.code && !isNaN(parseInt(req.query.code))
            ? req.query.code
            : 400

    res.status(code)

    return `Simulating code ${code}`
}

ExplorerApiRoutes[`/${ExplorersRoute}`] = async () => {
    // http://localhost:3030/admin/api/explorers.json
    // Download all explorers for the admin index page
    try {
        const explorers = await getAllExplorers()
        const branches = await git.branchLocal()
        const gitCmsBranchName = await branches.current
        const needsPull = false // todo: add

        return {
            success: true,
            gitCmsBranchName,
            needsPull,
            explorers: explorers.map((explorer) => explorer.toJson()),
        } as ExplorersRouteResponse
    } catch (err) {
        console.log(err)
        return {
            success: false,
            errorMessage: err,
        } as ExplorersRouteResponse
    }
}

ExplorerApiRoutes[`/${ExplorersRouteGrapherConfigs}`] = async (req) => {
    // Download all chart configs for Explorer create page
    const grapherIds = req.query[ExplorersRouteQueryParam].split("~")
    const configs = []
    for (const grapherId of grapherIds) {
        try {
            configs.push(await getGrapherById(grapherId))
        } catch (err) {
            console.log(`Error with grapherId '${grapherId}'`)
        }
    }
    return configs
}

export const addExplorerAdminRoutes = (app: Router, baseUrl: string) => {
    // i.e. http://localhost:3030/admin/explorers/preview/some-slug
    app.get(`/${EXPLORERS_PREVIEW_ROUTE}/:slug`, async (req, res) => {
        const slug = slugify(req.params.slug)
        const filename = slug + EXPLORER_FILE_SUFFIX
        if (slug === DefaultNewExplorerSlug)
            return res.send(
                await renderExplorerPage(
                    new ExplorerProgram(DefaultNewExplorerSlug, ""),
                    baseUrl
                )
            )
        if (!slug || !fs.existsSync(EXPLORERS_FOLDER + filename))
            return res.send(`File not found`)
        const explorer = await getExplorerFromFile(EXPLORERS_FOLDER, filename)
        return res.send(await renderExplorerPage(explorer, baseUrl))
    })
}

// todo: don't export once we remove covid legacy stuff?
export const getExplorerFromFile = async (
    directory = EXPLORERS_FOLDER,
    filename: string
) => {
    const fullPath = directory + "/" + filename
    const content = await fs.readFile(fullPath, "utf8")
    const commits = await git.log({ file: fullPath, n: 1 })
    return new ExplorerProgram(
        filename.replace(EXPLORER_FILE_SUFFIX, ""),
        content,
        commits.latest as GitCommit
    )
}

export const bakeAllPublishedExplorers = async (
    inputFolder = EXPLORERS_FOLDER,
    outputFolder: string,
    baseUrl: string
) => {
    const published = await getAllPublishedExplorers(inputFolder)
    await bakeExplorersToDir(outputFolder, published, baseUrl)
}

export const getAllPublishedExplorers = async (
    inputFolder = EXPLORERS_FOLDER
) => {
    const explorers = await getAllExplorers(inputFolder)
    return explorers.filter((exp) => exp.isPublished)
}

const getAllExplorers = async (directory = EXPLORERS_FOLDER) => {
    if (!fs.existsSync(directory)) return []
    const files = await fs.readdir(directory)
    const explorerFiles = files.filter((filename) =>
        filename.endsWith(EXPLORER_FILE_SUFFIX)
    )

    const explorers: ExplorerProgram[] = []
    for (const filename of explorerFiles) {
        const explorer = await getExplorerFromFile(directory, filename)

        explorers.push(explorer)
    }
    return explorers
}

const write = async (outPath: string, content: string) => {
    await fs.mkdirp(path.dirname(outPath))
    await fs.writeFile(outPath, content)
    console.log(outPath)
}

const bakeExplorersToDir = async (
    directory: string,
    explorers: ExplorerProgram[] = [],
    baseUrl: string
) => {
    for (const explorer of explorers) {
        await write(
            `${directory}/${explorer.slug}.html`,
            await renderExplorerPage(explorer, baseUrl)
        )
    }
}

const renderToHtmlPage = (element: any) =>
    `<!doctype html>${ReactDOMServer.renderToStaticMarkup(element)}`

export const renderExplorerPage = async (
    program: ExplorerProgram,
    baseUrl: string
) => {
    const { requiredGrapherIds } = program.decisionMatrix
    let grapherConfigRows: any[] = []
    if (requiredGrapherIds.length)
        grapherConfigRows = await queryMysql(
            `SELECT id, config FROM charts WHERE id IN (?)`,
            [requiredGrapherIds]
        )

    const wpContent = program.wpBlockId
        ? await getBlockContent(program.wpBlockId)
        : undefined

    const grapherConfigs: GrapherInterface[] = grapherConfigRows.map((row) => {
        const config = JSON.parse(row.config)
        config.id = row.id // Ensure each grapher has an id
        return new Grapher(config).toObject()
    })

    return renderToHtmlPage(
        <ExplorerPage
            grapherConfigs={grapherConfigs}
            program={program}
            wpContent={wpContent}
            baseUrl={baseUrl}
        />
    )
}