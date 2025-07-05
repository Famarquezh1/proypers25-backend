import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConsultaAutonomaComponent } from './consulta-autonoma.component';

describe('ConsultaAutonomaComponent', () => {
  let component: ConsultaAutonomaComponent;
  let fixture: ComponentFixture<ConsultaAutonomaComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConsultaAutonomaComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ConsultaAutonomaComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
