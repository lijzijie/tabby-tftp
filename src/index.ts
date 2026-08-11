import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, ToolbarButtonProvider } from 'tabby-core'

import { TftpButtonProvider } from './buttonProvider'
import { TftpModalComponent } from './components/tftpModal.component'
import { TftpServerComponent } from './components/tftpServer.component'
import { TftpConfigProvider } from './config'
import { TftpService } from './services/tftp.service'
import { TftpServerService } from './services/tftpServer.service'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCoreModule,
    ],
    declarations: [
        TftpModalComponent,
        TftpServerComponent,
    ],
    providers: [
        TftpService,
        TftpServerService,
        { provide: ConfigProvider, useClass: TftpConfigProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: TftpButtonProvider, multi: true },
    ],
})
export default class TftpModule { }

export * from './tftp/client'
export * from './tftp/protocol'
export * from './tftp/server'
