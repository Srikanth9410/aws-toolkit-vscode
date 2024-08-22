/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { env, version } from 'vscode'
import * as os from 'os'
import { getLogger } from '../logger'
import { fromExtensionManifest, migrateSetting, Settings } from '../settings'
import { memoize } from '../utilities/functionUtils'
import {
    isInDevEnv,
    extensionVersion,
    isAutomation,
    isRemoteWorkspace,
    isCloudDesktop,
    isAmazonInternalOs,
} from '../vscode/env'
import { addTypeName } from '../utilities/typeConstructors'
import globals, { isWeb } from '../extensionGlobals'
import { mapMetadata } from './telemetryLogger'
import { Result } from './telemetry.gen'
import { MetricDatum } from './clienttelemetry'
import { isValidationExemptMetric } from './exemptMetrics'
import { isAmazonQ, isCloud9, isSageMaker } from '../../shared/extensionUtilities'
import { randomUUID } from '../crypto'
import { ClassToInterfaceType } from '../utilities/tsUtils'
import { FunctionEntry, type TelemetryTracer } from './spans'
import { telemetry } from './telemetry'

const legacySettingsTelemetryValueDisable = 'Disable'
const legacySettingsTelemetryValueEnable = 'Enable'

const TelemetryFlag = addTypeName('boolean', convertLegacy)
export const telemetryClientIdEnvKey = '__TELEMETRY_CLIENT_ID'

export class TelemetryConfig {
    private readonly _toolkitConfig
    private readonly _amazonQConfig

    public get toolkitConfig() {
        return this._toolkitConfig
    }

    public get amazonQConfig() {
        return this._amazonQConfig
    }

    constructor(settings?: ClassToInterfaceType<Settings>) {
        class ToolkitConfig extends fromExtensionManifest('aws', {
            telemetry: TelemetryFlag,
        }) {}

        class AmazonQConfig extends fromExtensionManifest('amazonQ', {
            telemetry: TelemetryFlag,
        }) {}

        this._toolkitConfig = new ToolkitConfig(settings)
        this._amazonQConfig = new AmazonQConfig(settings)
    }

    public isEnabled(): boolean {
        return (isAmazonQ() ? this.amazonQConfig : this.toolkitConfig).get(`telemetry`, true)
    }

    public async initAmazonQSetting() {
        if (!isAmazonQ() || globals.globalState.tryGet('amazonq.telemetry.migrated', Boolean, false)) {
            return
        }
        // aws.telemetry isn't deprecated, we are just initializing amazonQ.telemetry with its value.
        // This is also why we need to check that we only try this migration once.
        await migrateSetting({ key: 'aws.telemetry', type: Boolean }, { key: 'amazonQ.telemetry' })
        await globals.globalState.update('amazonq.telemetry.migrated', true)
    }
}

export function convertLegacy(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value
    }

    // Set telemetry value to boolean if the current value matches the legacy value
    if (value === legacySettingsTelemetryValueDisable) {
        return false
    } else if (value === legacySettingsTelemetryValueEnable) {
        return true
    } else {
        throw new TypeError(`Unknown telemetry setting: ${value}`)
    }
}

/**
 * Calculates the clientId for the current profile. This calculation is performed once
 * on first call and the result is stored for the remainder of the session.
 *
 * Web mode will always compute to whatever is stored in global state or vscode.machineId.
 * For normal use, the clientId is fetched from the first providing source:
 * 1. clientId stored in process.env
 * 2. clientId stored in current extension's global state.
 * 3. a random UUID
 *
 * The clientId in the current extension's global state AND the clientId stored in process.env
 * is updated to the result of above to allow other extensions to converge to the same clientId.
 */
export const getClientId = memoize(
    /**
     * @param nonce Dummy parameter to allow tests to defeat memoize().
     */
    (
        globalState: typeof globals.globalState,
        isTelemetryEnabled = new TelemetryConfig().isEnabled(),
        isTest?: false,
        nonce?: string
    ) => {
        if (isTest ?? isAutomation()) {
            return 'ffffffff-ffff-ffff-ffff-ffffffffffff'
        }
        if (!isTelemetryEnabled) {
            return '11111111-1111-1111-1111-111111111111'
        }
        try {
            const globalClientId = process.env[telemetryClientIdEnvKey] // truly global across all extensions
            const localClientId = globalState.tryGet('telemetryClientId', String) // local to extension, despite accessing "global" state
            let clientId: string

            if (isWeb()) {
                const machineId = vscode.env.machineId
                clientId = localClientId ?? machineId
                getLogger().debug(
                    'getClientId: web mode determined clientId: %s, stored clientId was: %s, vscode.machineId was: %s',
                    clientId,
                    localClientId,
                    machineId
                )
            } else {
                clientId = globalClientId ?? localClientId ?? randomUUID()
                getLogger().debug(
                    'getClientId: determined clientId as: %s, process.env clientId was: %s, stored clientId was: %s',
                    clientId,
                    globalClientId,
                    localClientId
                )
                if (!globalClientId) {
                    getLogger().debug(`getClientId: setting clientId in process.env to: %s`, clientId)
                    process.env[telemetryClientIdEnvKey] = clientId
                }
            }

            globalState.tryUpdate('telemetryClientId', clientId)
            return clientId
        } catch (e) {
            getLogger().error('getClientId: failed to create client id: %O', e)
            const clientId = '00000000-0000-0000-0000-000000000000'
            return clientId
        }
    }
)

export const platformPair = () => `${env.appName.replace(/\s/g, '-')}/${version}`

/**
 * Returns a string that should be used as the extension's user agent.
 *
 * Omits the platform and `ClientId` pairs by default.
 */
export function getUserAgent(
    opt?: { includePlatform?: boolean; includeClientId?: boolean },
    globalState = globals.globalState
): string {
    const pairs = isAmazonQ()
        ? [`AmazonQ-For-VSCode/${extensionVersion}`]
        : [`AWS-Toolkit-For-VSCode/${extensionVersion}`]

    if (opt?.includePlatform) {
        pairs.push(platformPair())
    }

    if (opt?.includeClientId) {
        const clientId = getClientId(globalState)
        pairs.push(`ClientId/${clientId}`)
    }

    return pairs.join(' ')
}

/**
 * All the types of ENVs the extension can run in.
 *
 * NOTES:
 * - append `-amzn` for any environment internal to Amazon
 */
type EnvType =
    | 'cloud9'
    | 'cloud9-codecatalyst'
    | 'cloudDesktop-amzn'
    | 'codecatalyst'
    | 'local'
    | 'ec2'
    | 'ec2-amzn' // ec2 but with an internal Amazon OS
    | 'sagemaker'
    | 'test'
    | 'wsl'
    | 'unknown'

/**
 * Returns the identifier for the environment that the extension is running in.
 */
export async function getComputeEnvType(): Promise<EnvType> {
    if (isCloud9('classic')) {
        return 'cloud9'
    } else if (isCloud9('codecatalyst')) {
        return 'cloud9-codecatalyst'
    } else if (isInDevEnv()) {
        return 'codecatalyst'
    } else if (isSageMaker()) {
        return 'sagemaker'
    } else if (isRemoteWorkspace()) {
        if (isAmazonInternalOs()) {
            if (await isCloudDesktop()) {
                return 'cloudDesktop-amzn'
            }
            return 'ec2-amzn'
        }
        return 'ec2'
    } else if (env.remoteName) {
        return 'wsl'
    } else if (isAutomation()) {
        return 'test'
    } else if (!env.remoteName) {
        return 'local'
    } else {
        return 'unknown'
    }
}

/**
 * Validates that emitted telemetry metrics
 * 1. contain a result property and
 * 2. contain a reason propery if result = 'Failed'.
 */
export function validateMetricEvent(event: MetricDatum, fatal: boolean) {
    const failedStr: Result = 'Failed'
    const telemetryRunDocsStr =
        ' Consider using `.run()` instead of `.emit()`, which will set these properties automatically. ' +
        'See https://github.com/aws/aws-toolkit-vscode/blob/master/docs/telemetry.md#guidelines'

    if (!isValidationExemptMetric(event.MetricName) && event.Metadata) {
        const metadata = mapMetadata([])(event.Metadata)
        let msg = 'telemetry: invalid Metric: '

        if (metadata.result === undefined) {
            msg += `"${event.MetricName}" emitted without the \`result\` property, which is always required.`
        } else if (metadata.result === failedStr && metadata.reason === undefined) {
            msg += `"${event.MetricName}" emitted with result=Failed but without the \`reason\` property.`
        } else {
            return // Validation passed.
        }

        msg += telemetryRunDocsStr
        if (fatal) {
            throw new Error(msg)
        }
        getLogger().warn(msg)
    }
}

/**
 * Potentially helpful values for the 'source' field in telemetry.
 */
export const ExtStartUpSources = {
    firstStartUp: 'firstStartUp',
    update: 'update',
    reload: 'reload',
    none: 'none',
} as const

export type ExtStartUpSource = (typeof ExtStartUpSources)[keyof typeof ExtStartUpSources]

/**
 * Useful for populating the sendTelemetryEvent request from codewhisperer's api for publishing custom telemetry events for AB Testing.
 *
 * Returns one of the enum values of OptOutPreferences model (see SendTelemetryRequest model in the codebase)
 */
export function getOptOutPreference() {
    return globals.telemetry.telemetryEnabled ? 'OPTIN' : 'OPTOUT'
}

/**
 * Useful for populating the sendTelemetryEvent request from codewhisperer's api for publishing custom telemetry events for AB Testing.
 *
 * Returns one of the enum values of the OperatingSystem model (see SendTelemetryRequest model in the codebase)
 */
export function getOperatingSystem(): 'MAC' | 'WINDOWS' | 'LINUX' {
    const osId = os.platform() // 'darwin', 'win32', 'linux', etc.
    if (osId === 'darwin') {
        return 'MAC'
    } else if (osId === 'win32') {
        return 'WINDOWS'
    } else {
        return 'LINUX'
    }
}

/**
 * Decorator that simply wraps the method with a non-emitting telemetry `run()`, automatically
 * `record()`ing the provided function id for later use by {@link TelemetryTracer.getFunctionStack()}
 *
 * This saves us from needing to wrap the entire function:
 *
 * **Before:**
 * ```
 * class A {
 *     myMethod() {
 *         telemetry.function_call.run(() => {
 *                 ...
 *             },
 *             { emit: false, functionId: { name: 'myMethod', class: 'A' } }
 *         )
 *     }
 * }
 * ```
 *
 * **After:**
 * ```
 * class A {
 *     @withTelemetryContext({ name: 'myMethod', class: 'A' })
 *     myMethod() {
 *         ...
 *     }
 * }
 * ```
 */
export function withTelemetryContext(functionId: FunctionEntry) {
    function decorator<This, Args extends any[], Return>(
        originalMethod: (this: This, ...args: Args) => Return,
        _context: ClassMethodDecoratorContext // we dont need this currently but it keeps the compiler happy
    ) {
        function decoratedMethod(this: This, ...args: Args): Return {
            return telemetry.function_call.run(
                () => {
                    // DEVELOPERS: Set a breakpoint here and step in to it to debug the original function
                    return originalMethod.call(this, ...args)
                },
                {
                    emit: false,
                    functionId: functionId,
                }
            )
        }
        return decoratedMethod
    }
    return decorator
}
