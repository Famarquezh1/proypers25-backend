import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './servicios/theme.service';


@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  title = 'proypers25';

  constructor(private themeService: ThemeService) {
    this.themeService.init();
  }
}
